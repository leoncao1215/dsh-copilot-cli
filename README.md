# dsh-agent-copilot

A prototype replacement agent driver for DeepSeek Harness (dsh). Keep dsh's
workspace/worktree navigation, session UI, and terminal panels, while the real
GitHub Copilot CLI owns model execution, tools, and conversation context.

This is not a DeepSeek-compatible API proxy or an embedded terminal running the
Copilot TUI. It uses the official Copilot SDK to drive an installed Copilot CLI.

## Run from this checkout

Requirements: Node.js 24+, npm, and an installed, authenticated Copilot CLI
available on `PATH`. Confirm that Copilot works normally before launching.
Use your organization's permitted npm registry when installing dependencies.

```powershell
npm ci
.\start.ps1
```

`start.ps1` builds the plugin and opens the standard dsh Web app. It can also use
the portable Node installation in this checkout's ignored `.tools` directory
when Node is not on `PATH`. Alternatively, with Node available:

```powershell
npm run build
npm start
```

Startup arguments are forwarded to dsh Web:

```powershell
.\start.ps1 --no-open --port 3087
```

Open the authenticated URL printed by dsh. Create a workspace/session for your
repository or worktree and select a model under **GitHub Copilot CLI**. The
default is `auto`; available models come from the installed Copilot runtime.
Multiple sessions have separate Copilot identities and can execute concurrently.
Prompts within each session are serialized.

| Environment variable | Default                 | Purpose                                          |
| -------------------- | ----------------------- | ------------------------------------------------ |
| `DSH_HOME`           | `.dsh` in this checkout | Isolated dsh state and generated profile overlay |
| `DSH_COPILOT_CLI`    | `copilot` on `PATH`     | Path to the installed CLI executable             |
| `DSH_COPILOT_MODEL`  | `auto`                  | Initial Copilot model                            |

The launcher disables dsh telemetry and does not change your existing dsh home.
Copilot still uses its own authentication, configuration, and session storage;
`DSH_HOME` does not isolate those. Existing Copilot telemetry settings are
unchanged. Do not share the token-bearing startup URL.

## Integration

The generated overlay disables dsh's native `agent-loop` and LLM title generator,
registers this driver through `AgentRegistry.setFactory()`, and changes the
default model provider to `copilot-cli`. All other Web composition is retained.
Only one agent factory may be mounted.

Each dsh session ID maps deterministically to a Copilot session UUID. New sessions
create a durable Copilot conversation; reopening a session resumes that same
conversation, including after a complete process restart. Missing Copilot history
is an error, never a silent fresh conversation. Keep both stores for recovery.
Disconnecting a live session does not delete its Copilot history; deleting dsh
history does not currently delete the corresponding Copilot history.

Text/reasoning streams, assistant messages, root tool calls/results, turn
completion, errors, and cancellation are translated into dsh events and its
durable JSONL log. Pending inbox messages are persisted. Copilot permission
requests go through dsh's approval service, and questions through its user-input
service. Permissions are granted only for an explicit one-shot approval;
unavailable answerers fail closed. Requests for permission can wait for a
connected browser to answer.

## Current boundaries

- Pinned to **dsh 0.2.1-rc.3** and **Copilot SDK 1.0.28**. Newer dsh factory and
  projection contracts differ; this is not yet a version-independent plugin.
- Text prompts only. Attachments and dsh history forks are rejected explicitly.
  dsh rewind/compaction and native subagent management are not integrated.
- Copilot owns tools, instructions, hooks, MCP, and execution policy. dsh's
  native tool registry, sandbox modes, permission presets, and system-prompt
  assembly are **not translated** into equivalent Copilot settings. A dsh
  workspace-write badge is not a Copilot sandbox guarantee.
- One dsh step represents a complete SDK prompt execution, potentially including
  multiple model/tool iterations. Steering is queued for the next prompt, not
  injected into an in-progress Copilot model step.
- Root tool events use generic presentation. Nested subagent streams, rich native
  tool renderers, token/cost accounting, and full TUI feature parity are not
  implemented. Other dsh model providers may remain visible, but this driver
  accepts only the Copilot CLI provider.

## Development

```powershell
npm run typecheck
npm test
npm run lint
npm run build
```

The focused tests use real dsh services and JSONL persistence with a fake Copilot
runtime. `npm run smoke` additionally makes real Copilot requests through an
authenticated dsh Web server: chat, process-restart recovery, and a file-reading
tool call. It uses temporary state under `.smoke`, grants only reads of its exact
temporary marker file through a test-only answerer, and removes its created
Copilot session afterward. It consumes normal Copilot requests and does not test
browser rendering or interactive approval clicks.
