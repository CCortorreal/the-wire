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
