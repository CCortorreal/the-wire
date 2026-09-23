# the-wire protocol (v1)

Local, file-backed, two-provider messaging between live agent sessions. All state lives in
`<shared-root>/.wire/`: `wire.json` (the log), `cursors.json`, `leases.json`, `archive/`,
`wake.log`, optional `config.json`, and the append-only `operator.log`. State-file writes use locked
transactions (temp file → fsync → rename). This version is
local-machine only; do not put `.wire/` under a concurrent sync writer.

## Endpoints and mailboxes

An **endpoint** is `provider:session-uuid` — `claude:…` or `codex:…` — and names one live host
session exactly. Endpoints are cooperative declarations, not cryptographic identity: any process
with filesystem access can write the store.

A **mailbox** is a stable name (`claude`, `codex`, or anything `[a-z][a-z0-9._:-]*`) leased to one
endpoint at a time. `lease acquire` is atomic; a live lease rejects a second owner; each takeover
advances a durable **fence** so a stale holder cannot renew or release. Leases expire (default 30
min); the prompt hook renews on every prompt. `send --to codex` resolves the lease **at enqueue**
and the envelope's `to` is then immutable — a later takeover does not retarget stored mail.

## Envelope

```json
{
  "id": "uuid — stable per logical message; retries reuse it",
  "from": "claude:…", "to": "codex:…",
  "task": "identifier", "kind": "assignment | notice",
  "revision": "exact commit hash or artifact version",
  "summary": "curated text ≤4000 chars",
  "references": ["relative/path/in/root.md:12"],
  "supersedes": "uuid | null"
}
```

The stored record adds `hash` (sha256 of the canonical envelope), `seq` (per-recipient monotonic
sequence), `delivery`, `work`, `attempt`, `status`, timestamps. Re-enqueueing the same id with the
same content is a no-op; the same id with different content is refused.

Text validation is fail-closed: control bytes, over-length text, and credential-shaped strings
(private keys, `sk-`/`ghp_`/`xox?-` tokens, SSN shapes, `password=`) are rejected. References must
be relative, inside the root, and free of `..`, `vault`, `secret`, `credential`, `.pem`, `.key`.
These are backstops; the sender is responsible for what it puts on the wire.

Ask-shaped notice text (questions, review requests, or similar phrasing) produces an advisory
warning on stderr and in the successful send result, never a refusal. The envelope remains a
notice with `expectsResponse: false`. Optional `--notice-reason` records context. Use an
assignment with required `--done-state` when the recipient owes work; normal validation,
addressing and capacity failures still reject sends.

## Two independent state machines

**Delivery** (what the transport knows):

| state | meaning |
|---|---|
| `pending` | stored; no attempt claimed |
| `attempting` | attempt claimed durably *before* transport; a crash leaves this visible |
| `accepted` | Codex CLI returned a queued-message id for the exact thread |
| `unconfirmed` | Claude pipe closed, transport failed, timed out, or output unrecognized |
| `received` | the exact recipient recorded the envelope hash (hook pull, `inbox`, or `receive`) |

**Work** (what the recipient says):

| state | set by |
|---|---|
| `queued` | enqueue |
| `received` | first receipt of an assignment (notices go straight to `completed`) |
| `working` / `blocked` / `completed` | the recipient, via `status`, on the exact revision |
| `cancelled` | the sender via `status --state cancelled`, or operator recovery via `cancel` |
| `superseded` | a newer assignment with `supersedes` |
| `orphaned` | archive after the sender inactivity and age checks |

Rules the store enforces: transport can never assert `received`; a receipt that races a returning
transport wins; a terminal work state cannot be revived by a late receipt or status; `status`
requires receipt first (except cancel); revision must match; one active assignment per recipient.

## Dispatch, attempts, and the steward

`dispatch` claims an attempt (`pending → attempting`) in one transaction, *then* calls the
driver, then records `accepted|unconfirmed`. A second dispatch of the same message is refused —
there is no automatic retry at this layer, so a crash between claim and record can never produce
a duplicate send.

The **steward** (`the-wire steward`, run every minute from a scheduler) dispatches `pending`
messages and re-wakes `unconfirmed`/`attempting` ones with backoff: three fast re-wakes (5s, 30s,
120s), then a slow phase of one re-wake every 5 minutes for up to 12 more (about an hour), then it
stops for good (2026-09-21; FIELD-NOTES §18). Re-wakes call the driver directly and never modify
delivery state. It wakes the envelope's exact addressee — never a re-resolved lease holder.

The hook also runs on the host's **Stop** (end-of-turn) event when installed there: it pulls once,
and if anything new is addressed to this session it blocks the stop once with the inbox summary as
the reason, so the seat reads it in the same turn instead of at the human's next prompt. With
`stop_hook_active` set it does nothing (bounded), and an empty pull is silent.

## Pull, cursors, and the hook

Correctness is pull-driven. Each mailbox has a cursor `{observed, claims}`. `pull` selects
messages with `seq > observed` for this exact endpoint, marks them received, and only then advances
the cursor (delta-before-advance). Claims let a recipient track in-flight work per message and
complete out of order.

`lib/hook.mjs` on a prompt-submit event: renews/acquires this session's provider mailbox, consumes
a `WIRE-V1: <id> <hash>` envelope on the prompt's **first line** (a quoted envelope later in a
prompt is data), pulls, and returns a curated inbox summary as additional context. It never sends.

## Status and return notices

`status --state blocked|completed|cancelled` atomically inserts a `notice` addressed to the other
party (`"<state>: <id>. <summary>"`) and links it on the assignment. Repeating the same status is
idempotent (same notice, no duplicate). `working` creates no notice. A notice is terminal on
receipt and never produces an acknowledgment — this is what prevents ACK loops.

Operator recovery: `the-wire cancel --id <uuid> --operator carlos --reason "<text>"` cancels an assignment only if its sender holds no live lease. It records operator and reason in status and appends a durable cancel intent to `.wire/operator.log`; the matching status operation ID proves it applied. A crash can leave an intent alone. Identical retries are idempotent. It creates no return notice, so it works at full capacity.

## Capacity and archive

The live log holds 500 messages / 2 MB. Rolling `archive` moves completed, cancelled,
superseded and orphaned work to `.wire/archive/wire-<utc>-<unique>.json`, retaining open work.
Notices older than 24 hours with no live recipient lease or recent session event are archived
as `undelivered`. Assignments use the same inactivity test on the sender and become `orphaned`.
Unreadable or malformed session evidence retains the message. Sequences, cursors and leases
survive. No eligible messages means a no-op.
Send automatically runs rolling archive at 90% of either live-log cap before insertion.
Open work can still fill the log; capacity then refuses the send without losing it.
`read --id` can read archived records; retrying an archived ID deduplicates against its hash.
Late receipts and matching status/cancel retries recognize archives without reviving work
or generating another notice. A return notice already archived is never dispatched again.
Archive is written before the live log is replaced: an interrupted commit may leave a duplicate
archive copy, but never deletes the only copy of a message.

Limits come from optional `.wire/config.json` (missing keys use defaults):

```json
{"maxMessages":500,"maxBytes":2097152,"maxText":4000,"maxStatus":4000}
```

Values must be positive integers; unknown keys are rejected. Maxima are 100000 messages,
64 MiB, and 1000000 characters per text/status field. `health` reports effective limits and
serialized UTF-8 bytes. Legacy `wire.json` needs no migration. Lowering write limits does
not prevent reading an existing live log or archive up to 64 MiB. Generated WIRE-ID and
status-return prefixes do not consume the user text budget. Secret checks still apply.

## Activation boundary

A hook present in config is not active until the provider trusts it and a **new** session has
loaded it. After installing or changing the hook, the canary from a fresh session is the proof;
config inspection is not.

## Multi-session addressing

A single machine may run N Claude sessions and N Codex sessions concurrently. Each session can
hold one or more named mailboxes:

```
lease acquire --mailbox codex.inflow --as codex:<uuid-A>
lease acquire --mailbox codex.minecraft --as codex:<uuid-B>
```

The bare provider name (`codex`, `claude`) is one more mailbox, not a special concept. A session
that leases `codex.inflow` can also lease `codex` — but only one endpoint per mailbox at a time.
If session A holds `codex` and session B holds `codex.minecraft`, `send --to codex` reaches A and
`send --to codex.minecraft` reaches B.

**Hook support:** the prompt-submit hook accepts `--mailbox <name>` and leases that mailbox on
every prompt. It also calls `leaseRenewEndpoint` to renew _all_ mailboxes held by the session, so
a manually acquired mailbox stays alive as long as the session keeps prompting.

**Discovery:** `roster` (or `lease list`) shows all active mailboxes with their endpoints.

**Addressing errors:** `send --to codex` fails when no session holds a `codex` mailbox. If other
`codex.*` mailboxes exist, the error lists them — the sender picks the right one.

**Pull is endpoint-scoped, not mailbox-scoped.** A session receives messages addressed to its
exact endpoint regardless of which mailboxes it holds. Mailboxes are a naming convenience for
senders; they do not gate receipt.

`the-wire who` lists known endpoints, their mailboxes (including expired ones), lease ages
in milliseconds, and last seen timestamps from lease heartbeats or local session events.
An endpoint known only from a message has no mailbox and a null last-seen value. This is
a local directory, not proof that a session is running. `send --from`, `--to` and `--reply-to`
accept unique `provider:uuid-prefix` addresses; an ambiguous prefix fails with every matching
endpoint and its mailbox names. A full endpoint remains valid without a lease.

## Reply-to redirection (`--reply-to`)

Assignments can carry an optional `replyTo` endpoint or mailbox. When the recipient reports
`blocked`, `completed`, or `cancelled` status, the return notice goes to `replyTo` instead of the
original sender. This lets a desk session send work on behalf of a specialized session:

```
send --from claude --to codex.minecraft --reply-to claude.minecraft \
     --kind assignment --task architecture-review --summary "..." --done-state "review verdict"
```

When Codex completes the review, the return notice goes to `claude.minecraft`, not `claude` (the
desk). Sender cancellation (`--state cancelled`) always notifies the recipient directly regardless
of `replyTo` — the recipient needs to know its work was cancelled.

If `replyTo` is omitted or null, the return notice goes to the original sender (backward compatible).
`replyTo` must differ from the sender; setting it to the sender is rejected at envelope validation.
`replyTo` is resolved through the lease system at send time, the same way `--from` and `--to` are.

## Auto-replace (`--supersedes auto`)

`send --supersedes auto` atomically cancels the recipient's active assignment (any task) and
enqueues the new one. This differs from normal supersession (`--supersedes <id>`), which requires
the same task and marks the prior as `superseded`. Auto-replace marks the prior as `cancelled`
and records why in its status. It is a no-op (enqueues normally) when no active assignment exists.

The active-assignment error now includes the blocking message's ID and task so the sender can
choose: `--supersedes <id>` for same-task replacement, `--supersedes auto` for cross-task
replacement, or cancel + re-send manually.

## Durability and recovery

Every state mutation (wire.json, leases.json, cursors.json) goes through a single transaction
primitive: mkdir-lock → read → update → write temp → fsync → backup → rename → rmdir. A crash
leaves either the old file or the new one, never a torn one.

**Stale lock recovery:** the lock directory contains a `pid` sentinel (PID + timestamp). On
contention, if the holder's PID is dead or the lock is older than 30 seconds, the lock is broken
automatically. Four retries with backoff (50/100/200/500ms) handle transient contention from
concurrent hooks.

**Backup before write:** every transaction copies the current state to `.bak` before the rename.
If the primary file becomes corrupt (truncated, invalid JSON), `the-wire repair` restores from
the backup. The corrupt file is preserved as `.corrupt.<timestamp>` for forensics.

**Orphaned temp cleanup:** `.tmp` files older than 30 seconds are cleaned at the start of every
transaction. A crash after writeFileSync but before rename leaves a temp file; it is harmless and
cleaned on the next operation.

**Hash stability:** the integrity check hashes the stored envelope verbatim (`digest(m.envelope)`)
rather than re-canonicalizing through `envelope()`. This means adding new optional fields to the
envelope schema never breaks existing messages. The hash was computed at insert time over the
canonical form; at load time, the stored form IS the canonical form from that version.

**Repair verb:** `the-wire repair` fixes stale locks, orphaned temps, corrupt-to-backup recovery,
and reports hash mismatches (tampered messages). It does not modify messages or leases beyond
recovery. Run it when any operation fails with a persistent error.

**Error diagnostics:** corruption and "unknown message" errors include the message ID so the
operator can identify and investigate the specific message. `validateState` (load-time) and `find`
(transaction-time) both report the offending ID on hash mismatch.

**Archive uniqueness:** archive filenames include an 8-character random suffix after the timestamp
(`wire-<iso>-<rand8>.json`) to prevent same-second collision when rapid archive cycles occur.

**Defensive context:** the `context()` function degrades gracefully if the cursor state file is
corrupt or unreadable — it treats the cursor as zero (all messages are "new") rather than crashing
the prompt hook. The hook's top-level catch provides the final safety net.

**Hook flag parser:** `flag()` returns `undefined` when a flag is absent, not a positional argument
from a different flag. This prevents wasted lease-acquire attempts on every hook invocation.

## Verification status

- Broker semantics (dedupe, supersession, attempt claim, receipt precedence, atomic notices,
  capacity rollback, cursors, leases, archive gating): covered by `test/wire.test.mjs`, which runs
  the CLI end to end against a stubbed Codex binary.
- Live round trips Claude ⇄ Codex, hook-pulled receipt, and steward re-wake: observed on one
  Windows 11 machine in September 2026. Not yet observed on macOS/Linux — see `docs/FIELD-NOTES.md`.

<!-- EVIDENCE id=broker-recovery-tests rung=supported n=1 blind="temporary roots on one Windows host; live wire unchanged" detector=validated -->
Recovery, configurable caps, prefix collisions and notice warnings have regression coverage in
`test/recovery.test.mjs` and `test/grammar.test.mjs`. Live recovery awaits operator review.
