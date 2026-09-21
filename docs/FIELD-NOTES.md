# Field notes

What was found by probing the real runtimes, not read from a spec. Each note says how sure we
are: **established** (seen repeatedly, independently), **supported** (seen, one vantage point),
**suspected** (a reading of the evidence, not yet tested). Refuted notes stay, marked refuted.

## 1. Claude Code publishes a peer message pipe — **established**

Each live Claude Code session writes `~/.claude/sessions/<pid>.json` (session id, cwd, a
`messagingSocketPath`, `startedAt`) and a sibling `<pid>.<sha256>.key` holding a `peerToken`. A
client that connects to the pipe and writes `{"type":"auth","token":…}` then
`{"type":"user", session_id, from, msg_id, message:{role:"user",content}, priority:"next"}` as
newline-delimited JSON gets the message delivered as the session's **next** input. It does not
interrupt the running turn.

On Windows the pipe is `\\.\pipe\LOCAL\cc-msg-<hex>`. `lib/drivers/claude-transport.mjs` is a copy
of the observed protocol with a stable `--message-id`. It is version-sensitive; if a Claude Code
update breaks it, inspect the installed runtime rather than guessing frames.

*Blind spot:* Windows only. The POSIX socket path shape is an assumption (`localPipe()` accepts any
absolute path containing `cc-msg-` there). First macOS/Linux report welcome.

## 2. A closed pipe is not delivery — **established**

The pipe closes cleanly whether or not the session consumed the frame. The broker therefore never
marks a Claude-bound message `accepted`; it stays `unconfirmed` until the recipient's own pull
records the hash. Report "sent", "acknowledged" and "consumed" as three separate facts.

## 3. Codex's `queue` works while its app-server daemon is dead — **supported, n=1**

`codex queue --thread <uuid> --message <text>` returned `Queued message <uuid> for thread <uuid>.`
and the message surfaced in the target Codex task **after that task's current turn ended**, on a
machine where `codex app-server daemon version` reported a dead control socket. Do not start a
daemon, change ACLs, or open a second Codex session to "fix" the socket; the queue path does not
need it.

*Blind spot:* one CLI build (`0.154.0-alpha.6.2`) on one Windows host. Because transport
acceptance is a safety boundary, the success line is matched as one complete line with two valid
UUIDs and the exact target thread. A wording change fails closed to `unconfirmed`; `doctor
--provider codex` separately probes whether `queue --help` still advertises `--thread` and
`--message`.

## 4. From inside Codex's sandbox, the Claude pipe returns `EPERM` — **supported, n=1**

The same send succeeded through Codex's normal escalated-approval mechanism. The right move after
an explicit permission error is to ask for that approval, not to disable the sandbox, impersonate
a Claude process, reuse a child token, or edit the registry. An `unconfirmed` wake alone does not
establish that `EPERM` occurred and must not trigger an automatic retry.

## 5. Windows `codex` on PATH is always an npm `.cmd` shim — **refuted**

One observed installation used an npm `.cmd`, but a later Codex Desktop installation exposed a
native `codex.exe` on `PATH`. The driver now prefers a real `.exe`/`.com`, then uses an npm
`codex.js` only when `stat` proves it is a readable file. This matters inside sandboxes where an
access check can succeed for a path that cannot actually be opened. `THE_WIRE_CODEX_BIN` remains
the explicit escape hatch for other layouts.

## 6. Codex exposes its current session id to child commands — **supported, n=1**

On the observed Codex Desktop build, `CODEX_THREAD_ID` and `CODEX_SESSION_ID` both carried the
current task UUID. `the-wire discover` validates and reports those variables before suggesting a
thread-listing tool or asking the user. This is stronger than selecting a rollout file by mtime,
but it is not documented as a cross-host contract.

*Blind spot:* one Codex Desktop build. Other Codex hosts may expose neither variable.

## 7. Re-waking through a mailbox lease delivers to the wrong session — **established (fixed)**

The steward once re-resolved `<provider>-desk` on every re-wake. A lease takeover between the
original send and the re-wake sent three copies of one session's notice to *another* session. The
envelope's `to` is exact and immutable; the steward now wakes the addressee and nobody else.

## 8. Pull-path receipt is real — **supported**

With the prompt hook installed, a notice sent to a Claude session was recorded `received` by the
hook's pull *before* the session's model saw or acted on anything, and the push wake had been
`unconfirmed`. Transport is latency; the hook is correctness.

*Blind spot:* one session pair, one day.

## 9. The same skill fires at very different rates on the two providers — **suspected (cause)**

Codex's developer message lists every project skill *with its full frontmatter description*
(from `.agents/skills/` and its user/system roots), so the model can select a skill from its
trigger description. One project skill loaded in 26 Codex sessions and 0 Claude sessions over a month. The
Claude lane first read this as "Claude lists project skills by name only" — the model-visible list
in that session did show bare names — but the Codex lane's independent audit found Claude Skill
calls for *other* skills in the same period, so description matching does work there. The
surviving explanation is weaker: trigger wording and where it sits (front-loaded vs. buried) matter
more on Claude, and a plain-prose line in `CLAUDE.md` is the reliable backstop. Consequence for
the-wire: `CLAUDE.md`/`AGENTS.md` carry the trigger in prose, `BOOTSTRAP.md` is what the agent
reads, and the skill description leads with its verbs.

*Blind spot:* one machine, one month, two different transcript parsers (the two lanes counted
differently — which is itself the lesson).

## 10. Two sessions, one prompt — **supported**

The cleanest way to bring the second agent up was to paste the *same* human prompt into both.
Each one then found the other by matching that prompt in the peer's transcript — which is exactly
the guess the-wire replaces with leases: the agent that leased `codex` is the one you mean.

## 11. Caps — **established**

Summaries: 1200 chars. Status summaries: 1000. Log: 100 messages / 256 KB. These bit the authors
within the first hour of real use. They are deliberate: the wire carries decisions and pointers;
the repo carries the work.

## 12. POSIX behavior is a design reading, not a port — **suspected**

The file-backed broker uses Node filesystem primitives that exist on macOS and Linux, and the
Codex driver falls back to an executable named `codex` on `PATH`. The Claude transport accepts an
absolute Unix-domain socket path containing `cc-msg-`, and Node can connect to such a path. Those
facts make a POSIX port plausible; they do not establish the registry schema, socket naming,
authentication frame, hook behavior, or live round trip on either platform.

Two narrower cautions follow from the implementation:

- The transaction writes and fsyncs a temporary file before renaming it in the same directory.
  That protects against a torn process write, but the parent directory is not fsynced; power-loss
  durability on POSIX is not established.
- State-file permissions inherit the user's umask. The wire assumes one OS user and a shared root
  that is not writable by untrusted local users. Do not use it as a multi-user IPC boundary.

On POSIX, a socket permission failure may be `EACCES` rather than Windows `EPERM`. Report the
actual error and use the host's normal approval model; never translate an unconfirmed wake into a
permission diagnosis.

## 13. The first live round trip through the published repo — **supported, n=1**

Minutes after v0.1.0 went public, the two authoring sessions ran BOOTSTRAP against it on the
same Windows machine, sharing one root. Claude sent one canary notice; the Codex CLI accepted it
(`queue` returned a message id for the exact thread); Codex read it from the store, recorded the
receipt with the exact hash, and sent exactly one return notice. Claude pulled that return by hand
with `the-wire inbox` — its prompt hook had not been merged yet — and the store showed both
envelopes `received`/`completed`. Neither side re-sent anything, and neither side touched its own
hook file on the strength of a peer message.

Three things this does and does not establish:

- The pull path is sufficient. A half without its hook still receives; the hook only removes the
  chore. Ship the hook merge as the last step, not a prerequisite.
- "Accepted" and "received" stayed distinct in practice: the Codex return notice sat at `accepted`
  on Codex's side until Claude's pull recorded it. Reporting them as one state would have been a
  lie for several minutes.
- The permission boundary bit the author, not the tool: the Claude session's own host classifier
  blocked the first attempt to merge the hook snippet. It surfaced the snippet and waited for the
  human, which is what BOOTSTRAP asks of an agent.

*Blind spot:* one machine, one root, both sessions already primed by having written the code.
A stranger's agent on a stranger's machine is the next experiment.

## 14. Bare-mailbox replies cross-wire multi-session pairs — **established (mitigated)**

With two Claude+Codex pairs running (desk and minecraft), a session that received a message via
direct endpoint and replied with `--to codex` (bare mailbox) hit the wrong Codex — whichever
held the bare `codex` lease, not the one that sent the original message. The dotted-mailbox
scheme prevents this *if* both sides lease scoped names before the first message, but the
failure mode is silent: the reply routes successfully, just to the wrong session.

Mitigation: `--in-reply-to <message-id>` on `send` reads the original message and auto-routes
to its sender's exact endpoint. No bare-mailbox resolution, no cross-wire. The flag also
inherits `--task` and `--revision` from the original message, reducing required flags for a
reply to just `--from`, `--kind`, and `--summary`. Only the original recipient can use
`--in-reply-to` (third-party replies are rejected).

## 15. Dead sessions block lease acquisition — **established (fixed)**

A hard-killed session (Ctrl+C, process kill, system reboot) leaves its lease "live" by timestamp
for up to 30 minutes. A new session trying to acquire the same mailbox gets
`"already has a live lease"` and must manually release with the dead session's fence token —
a multi-step process requiring the operator to read the lease list.

Fix: `leaseAcquire` calls `holderLiveness(endpoint)`, which reads the specific holder's
registry record from `~/.claude/sessions/<pid>.json` by matching `sessionId`, validates that
the filename PID matches the JSON `pid` field, then probes with `process.kill(pid, 0)`.
Returns a tri-state: `alive` (probe succeeded), `dead` (ESRCH), `unknown` (no registry, no
matching record, PID/filename mismatch, multiple matches, or non-Claude provider). Eviction
fires only on `dead`; `unknown` blocks eviction (no false eviction).

## 16. Expired leases make idle sessions unreachable — **established (fixed)**

A session that goes idle for 30 minutes (the lease TTL) loses its mailbox — `leaseResolve`
returns null, and `--to codex` (bare mailbox) fails even though the session is alive and
capable of receiving work. The workaround was knowing and typing the full endpoint UUID,
which defeats the purpose of named mailboxes.

Fix: `holderLiveness(endpoint)` returns a tri-state: `alive` (PID probe succeeded), `dead`
(ESRCH), or `unknown` (no probe — Codex, missing registry, ambiguous records). `leaseResolve`
resolves expired leases only when the holder is **proven alive** — unknown holders do not
self-heal. `leaseList` reports `active` / `stale` (expired + alive) / `expired` (expired +
dead or unknown). Stale leases resolve for addressing but can be freely taken over by
`leaseAcquire` — expiry gates takeover, not resolution. Eviction in `leaseAcquire` fires
only on `dead`, never on `unknown` — same fail-safe as before.

## 17. Second session is invisible when bare mailbox is taken — **established (fixed)**

When multiple sessions of the same provider run, the first to boot claims the bare mailbox
(`claude` or `codex`). Every subsequent session's hook silently fails `leaseAcquire` and
holds **no mailbox at all** — it's completely invisible to bare-name addressing. The session
can still pull its inbox (messages addressed to its endpoint arrive), but it can't be
reached by peers using `--to claude` and has no mailbox name to use for `--from`.

Fix: the hook now auto-acquires a scoped mailbox when the bare mailbox is taken and the
session holds no mailbox. It tries progressively longer UUID prefixes (4, 8, 12, full) until
one is available (e.g., `claude.c9f8`, or `claude.c9f8c3c1` on 4-char collision). The scoped
name is deterministic and appears in `lease list` and `roster`.

If all four candidates are already occupied (rare — requires other sessions to have explicitly
claimed those exact scoped names, since random UUIDs won't collide at full length), the
session runs with no named mailbox and the hook emits a warning:
peers must use the full endpoint (`provider:uuid`) to address it. The warning breaks the
quiet-exit path so it is always visible.

## 18. A desktop Claude session does not consume pipe wake frames — **supported, n=1 host, one day**

Observed 2026-09-21 on one Windows 11 host (Claude desktop entrypoint, `claude-desktop` in the session
registry). Codex's notice `1f133e82` was enqueued 19:36Z; the steward re-woke the target session
three times (19:37, 19:38, 19:39Z, each `ok`: pipe connected, auth + user frames written, pipe
closed). The session's transcript received none of them, and the message was only pulled at
20:03Z by the prompt hook when the human typed. A labeled self-wake frame written at 20:08Z while
the session was idle also never appeared. Across the whole day, one pipe frame reached that
session's transcript (16:26Z) out of dozens reported `ok`. The Codex direction is unaffected
(`queue` accepted, pulled within ten seconds).

Consequences (both Carlos-approved 15:11 CDT): the steward gained a slow re-wake phase (§ dispatch
in PROTOCOL.md), and the hook runs on the Stop event so the seat pulls at the end of every turn
rather than only when the human types. Note §2 stands: "ok" was never delivery. What is new is
that on this host the push path is close to a no-op for Claude targets, so the wire's latency was
the human's typing cadence.

*Blind spot:* one host, one Claude build, one day. Whether the frames are dropped while a turn is
in progress, ignored by the desktop entrypoint, or consumed somewhere the transcript does not show
is not known; the CLI entrypoint was not tested.
