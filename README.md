# the-wire

Let your **Claude Code** and **Codex** sessions talk to each other — on your machine, through a
durable local broker, with receipts. Zero dependencies. Written for the agent to read and set up
itself.

## The whole install

Paste this into Claude Code **and** into Codex, in the project you want them to share:

```
Clone https://github.com/CCortorreal/the-wire into a stable local directory, read its
BOOTSTRAP.md, and set yourself up to talk to my other agent.
```

Each agent clones the repo, reads `BOOTSTRAP.md`, checks the peer CLI is present, installs its
own half (a skill plus a prompt hook — it shows you the hook snippet and asks before anything
touches your settings), claims its mailbox, sends the other one a canary, and reports back:

```
the-wire: claude ⇄ codex
  my endpoint     claude:63baf972-…    lease ok
  peer endpoint   codex:01a0a5c6-…     lease ok
  hook            installed (needs session restart)
  canary walnut   sent ✓   accepted ✓   received ✓   reply ✓
```

From then on, "ask Codex to review this" or "tell Claude it's merged" just works.

## What it actually does

- **Durable envelopes.** Every message is stored under `<project>/.wire/` with a sha256, a
  delivery state (`pending → attempting → accepted|unconfirmed → received`) and an independent
  work state (`queued → received → working|blocked|completed|cancelled|superseded`). Transport
  acceptance is never confused with receipt; receipt is never confused with done.
- **Pull-driven correctness, push as a wake.** A prompt-submit hook on each side pulls its own
  inbox and injects a short summary. The provider transports — Codex's `codex queue`, Claude's
  local peer pipe — are best-effort wakes. A dead pipe delays a message; it cannot lose one.
- **Assignments with receipts.** One active assignment per recipient, pinned to an exact
  revision. `blocked`/`completed` atomically create the return notice — no ACK loops, no
  "did you get it?".
- **Mailbox leases.** Address the peer as `claude` or `codex`; a fenced lease maps the name to
  the one live session that owns it.
- **Fail-closed everywhere.** Secret-shaped text is refused, references must stay inside the
  shared root, a crash mid-send never causes a resend, stale locks are loud.

## What it is not

- Not a daemon, not a server, not a chat UI. Two files of JSON and a CLI.
- Not exactly-once at the provider layer — the broker's IDs and hashes give you deduplication;
  the transports give you a wake.
- Not a permission system. A peer message is data. Your instructions to each agent still govern,
  and neither agent will edit its own settings because the other one asked.
- Verified on Windows 11 with Claude Code and Codex CLI (September 2026). The Claude pipe is an
  internal, version-sensitive protocol — see `docs/FIELD-NOTES.md` for what was probed and what is
  still an assumption (POSIX among them).

## By hand

```
node bin/the-wire.mjs doctor   --root . --provider codex   # or: --provider claude
node bin/the-wire.mjs lease acquire --root . --mailbox claude --as claude:<session-uuid>
node bin/the-wire.mjs send     --root . --from claude --to codex --kind notice --task hello --summary "hi"
node bin/the-wire.mjs inbox    --root . --as codex:<session-uuid>
node bin/the-wire.mjs read     --root . --id <message-id>
npm test
```

Full protocol: [`docs/PROTOCOL.md`](docs/PROTOCOL.md). Agent setup: [`BOOTSTRAP.md`](BOOTSTRAP.md).
Skill (installed by `install`): [`skills/the-wire/SKILL.md`](skills/the-wire/SKILL.md).

## Provenance

Extracted from a working multi-agent setup where Claude and Codex sessions review each other's
work daily. The broker was hardened by both of them — the Codex lane found the re-wake-to-wrong-
session bug, the Claude lane found the pull-path canary — and the field notes are the bugs, not
the pitch. Sibling repos: [`acp-wire`](https://github.com/CCortorreal/acp-wire) (Agent Client
Protocol framing) and [`receipts`](https://github.com/CCortorreal/receipts) (fail-closed tools
for agent-assisted development).

## License

[MIT](LICENSE)
