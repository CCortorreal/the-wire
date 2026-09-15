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

## 3. Codex's `queue` works while its app-server daemon is dead — **supported**

`codex queue --thread <uuid> --message <text>` returned `Queued message <uuid> for thread <uuid>.`
and the message surfaced in the target Codex task **after that task's current turn ended**, on a
machine where `codex app-server daemon version` reported a dead control socket. Do not start a
daemon, change ACLs, or open a second Codex session to "fix" the socket; the queue path does not
need it.

*Blind spot:* one CLI version (2026.09). The success line is matched loosely for that reason.

## 4. From inside Codex's sandbox, the Claude pipe returns `EPERM` — **supported**

The same send succeeded through Codex's normal escalated-approval mechanism. The right move is to
ask for that approval, not to disable the sandbox, impersonate a Claude process, reuse a child
token, or edit the registry.

## 5. Windows `codex` on PATH is an npm `.cmd` shim — **established**

A `.cmd` cannot be spawned without a shell. `codex-queue.mjs` prefers running
`%APPDATA%/npm/node_modules/@openai/codex/bin/codex.js` under the current `node`; set
`THE_WIRE_CODEX_BIN` to override. (Same trap as in `acp-wire`.)

## 6. Re-waking through a mailbox lease delivers to the wrong session — **established (fixed)**

The steward once re-resolved `<provider>-desk` on every re-wake. A lease takeover between the
original send and the re-wake sent three copies of one session's notice to *another* session. The
envelope's `to` is exact and immutable; the steward now wakes the addressee and nobody else.

## 7. Pull-path receipt is real — **supported**

With the prompt hook installed, a notice sent to a Claude session was recorded `received` by the
hook's pull *before* the session's model saw or acted on anything, and the push wake had been
`unconfirmed`. Transport is latency; the hook is correctness.

*Blind spot:* one session pair, one day.

## 8. The same skill fires at very different rates on the two providers — **suspected (cause)**

Codex's developer message lists every project skill *with its full frontmatter description*
(from `.agents/skills/` and its user/system roots), so a skill fires whenever the description
matches. One project skill loaded in 26 Codex sessions and 0 Claude sessions over a month. The
Claude lane first read this as "Claude lists project skills by name only" — the model-visible list
in that session did show bare names — but the Codex lane's independent audit found Claude Skill
calls for *other* skills in the same period, so description matching does work there. The
surviving explanation is weaker: trigger wording and where it sits (front-loaded vs. buried) matter
more on Claude, and a plain-prose line in `CLAUDE.md` is the reliable backstop. Consequence for
the-wire: `CLAUDE.md`/`AGENTS.md` carry the trigger in prose, `BOOTSTRAP.md` is what the agent
reads, and the skill description leads with its verbs.

*Blind spot:* one machine, one month, two different transcript parsers (the two lanes counted
differently — which is itself the lesson).

## 9. Two sessions, one prompt — **supported**

The cleanest way to bring the second agent up was to paste the *same* human prompt into both.
Each one then found the other by matching that prompt in the peer's transcript — which is exactly
the guess the-wire replaces with leases: the agent that leased `codex` is the one you mean.

## 10. Caps — **established**

Summaries: 1200 chars. Status summaries: 1000. Log: 100 messages / 256 KB. These bit the authors
within the first hour of real use. They are deliberate: the wire carries decisions and pointers;
the repo carries the work.
