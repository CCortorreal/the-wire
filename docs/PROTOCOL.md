# the-wire protocol (v1)

Local, file-backed, two-provider messaging between live agent sessions. All state lives in
`<shared-root>/.wire/`: `wire.json` (the log), `cursors.json`, `leases.json`, `archive/`,
`wake.log`. Every write is a locked transaction (temp file → fsync → rename). This version is
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
  "summary": "curated text ≤1200 chars",
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
| `cancelled` | the sender, via `status --state cancelled` |
| `superseded` | a newer assignment with `supersedes` |

Rules the store enforces: transport can never assert `received`; a receipt that races a returning
transport wins; a terminal work state cannot be revived by a late receipt or status; `status`
requires receipt first (except cancel); revision must match; one active assignment per recipient.

## Dispatch, attempts, and the steward

`dispatch` claims an attempt (`pending → attempting`) in one transaction, *then* calls the
driver, then records `accepted|unconfirmed`. A second dispatch of the same message is refused —
there is no automatic retry at this layer, so a crash between claim and record can never produce
a duplicate send.

The **steward** (`the-wire steward`, run every minute from a scheduler) dispatches `pending`
messages and re-wakes `unconfirmed`/`attempting` ones with backoff (5s, 30s, 120s; 3 re-wakes
max). Re-wakes call the driver directly and never modify delivery state. It wakes the envelope's
exact addressee — never a re-resolved lease holder.

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

## Capacity and archive

The log holds 100 messages / 256 KB and refuses additions beyond that. `archive` refuses while any
assignment is non-terminal or any notice is unsent, with one exception: a notice older than 24 h
whose recipient holds no live lease and has no recent session record is archived with an explicit
`undelivered` disposition. The full log is copied to `.wire/archive/wire-<utc>.json`; sequences,
cursors and leases survive the reset.

## Activation boundary

A hook present in config is not active until the provider trusts it and a **new** session has
loaded it. After installing or changing the hook, the canary from a fresh session is the proof;
config inspection is not.

## Verification status

- Broker semantics (dedupe, supersession, attempt claim, receipt precedence, atomic notices,
  capacity rollback, cursors, leases, archive gating): covered by `test/wire.test.mjs`, which runs
  the CLI end to end against a stubbed Codex binary.
- Live round trips Claude ⇄ Codex, hook-pulled receipt, and steward re-wake: observed on one
  Windows 11 machine in September 2026. Not yet observed on macOS/Linux — see `docs/FIELD-NOTES.md`.
