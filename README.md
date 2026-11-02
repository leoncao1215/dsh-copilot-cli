# dsh-agent-copilot

A prototype replacement agent driver for DeepSeek Harness (dsh). Keep dsh's
workspace/worktree navigation, session UI, and terminal panels, while the real
GitHub Copilot CLI owns model execution, tools, and conversation context.

This is not a DeepSeek-compatible API proxy or an embedded terminal running the
Copilot TUI. It uses the official Copilot SDK to drive an installed Copilot CLI.

## Install through dsh's UI

Requirements: **dsh 0.2.1-rc.3**, Node.js 24+, and an installed, authenticated
Copilot CLI available to the process running dsh. The usual dsh plugin installer
also requires pnpm. Configure its permitted registry as you normally would.

In dsh's plugin manager, choose **Add Plugin** and paste:

```text
https://github.com/leoncao1215/dsh-copilot-cli
```

Install and enable the bundle, then restart dsh before creating a new session.
The bundle disables the native agent loop and LLM title generator, loads the
Copilot driver, and selects `copilot-cli / auto` as the default. No checkout,
manual build, npm publication, or `start.ps1` is needed for this installation.
Compiled `dist` files are included in Git so the plugin itself needs no install
scripts or build-script approval.
If pnpm asks about a native dependency's build script (for example `koffi` from
the SDK), use dsh's normal review/approve-and-retry flow for that dependency.

Configure `cliPath`, `model`, `permission`, and `turnTimeoutMs` on the
`copilot-agent-driver` plugin entry if needed. The standalone launcher's
`DSH_COPILOT_*` variables do not configure a UI-installed bundle.

This replaces the agent driver for the **whole selected dsh profile**, not just
one session. Existing native dsh conversations cannot be resumed as Copilot
conversations; create new sessions after switching. Disable this bundle and
restart dsh to restore the underlying native-driver configuration. Later
profile/user overrides take precedence over a bundle; remove conflicting
overrides if both drivers are enabled or the default provider stays unchanged.

## Run from this checkout instead

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
service. Normally, permissions require an explicit one-shot approval;
unavailable answerers fail closed. Dsh's full-access combination
(`danger-full-access` sandbox mode and `never` approval policy) automatically
approves Copilot tool permission requests without prompting. `never` alone
still rejects permission requests, and the driver's `permission: deny` overrides
full access. The current effective policy is included with each Copilot prompt,
and permission callbacks re-read it so changes apply to subsequent requests,
including within a running turn. Requests for permission can wait for a
connected browser to answer.

The driver requests detailed reasoning summaries where the model supports them
and handles both incremental and complete reasoning events. Runtime intent,
tool progress, and subagent start/completion/failure appear as labeled context
notices in the session. Subagent responses and exposed reasoning are shown
separately from the main answer, with streaming fragments batched at paragraph,
size, or time boundaries. These display-only notices are persisted but are not
sent back to Copilot as instructions. Only reasoning actually exposed by the
runtime can be displayed; model support varies.

## Current boundaries

- Pinned to **dsh 0.2.1-rc.3** and **Copilot SDK 1.0.28**. Newer dsh factory and
  projection contracts differ; this is not yet a version-independent plugin.
- Text prompts only. Attachments and dsh history forks are rejected explicitly.
  dsh rewind/compaction and native subagent management are not integrated.
- Copilot owns tools, instructions, hooks, MCP, and execution policy. dsh's
  native tool registry, sandbox confinement, and system-prompt assembly are
  **not translated** into equivalent Copilot settings. Only the full-access
  mode/policy combination is mapped to automatic tool approval; a dsh
  workspace-write badge is not a Copilot sandbox guarantee. Copilot runtime and
  organization restrictions still apply.
- Each settled main-assistant message has its own dsh presentation step, kept
  open until its tool calls settle. Runtime notices may also occupy a step;
  these are presentation boundaries, not exact Copilot model-call accounting.
  Steering is queued for the next prompt, not injected into an in-progress
  Copilot model step.
- Root tool events use generic presentation. Subagent activity is displayed as
  labeled notices, not native dsh child sessions or nested tool renderers.
  Token/cost accounting and full TUI feature parity are not implemented.
  Other dsh model providers may remain visible, but this driver accepts only
  the Copilot CLI provider.

## Development

Rebuild and commit `dist` together with source changes: GitHub installs use these
checked-in artifacts directly rather than running a compiler on the user's host.

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

`npm run smoke:install` starts an unmodified dsh Web profile and calls the same
plugin-manager API used by Add Plugin with the GitHub URL. It then restarts,
runs the conversation/tool checks, and disables the bundle to check recovery.
Set `DSH_COPILOT_INSTALL_SPEC` to an absolute package tarball path to exercise
unpublished changes through that same installer.
