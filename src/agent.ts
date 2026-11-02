import type { Context } from "@deepseek-ai/cordis";
import {
  agentEvents,
  type Agent,
  type AgentCancelCause,
  type AgentOptions,
  type CancelOptions,
  type InboxState,
  type InboxTarget,
  type ModelSelection,
} from "@deepseek-ai/dsh-agent";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
import { createScope, type Scope } from "@deepseek-ai/dsh-scope";
import type { Session, TurnEndReason } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-sandbox-policy";
import type {} from "@deepseek-ai/dsh-user-approval";
import type {} from "@deepseek-ai/dsh-working-directory";
import { CopilotInbox } from "./inbox.js";
import { PROVIDER, type RuntimeSession } from "./runtime.js";
import { Transcript } from "./transcript.js";

export class CopilotAgent implements Agent {
  readonly id;
  readonly scope: Scope;
  readonly ctx: Context;
  readonly inbox: CopilotInbox;
  readonly events;
  remote?: RuntimeSession;
  private active?: Promise<void>;
  private controller?: AbortController;
  private ready = false;
  private disposed = false;
  private maintenance = false;
  private failure?: unknown;
  private turn: number;
  private cwd?: string;
  status: "idle" | "running" = "idle";

  constructor(
    ctx: Context,
    readonly session: Session,
    readonly options: AgentOptions,
    private readonly timeoutMs: number,
    private readonly permission: "ask" | "deny" = "ask",
  ) {
    this.id = session.id;
    this.scope = createScope(ctx, this);
    this.ctx = this.scope.ctx;
    this.events = agentEvents(this.ctx, this);
    this.inbox = new CopilotInbox(
      session,
      () => {
        const state = this.ctx.sessionProjections.stateOf(session, "inbox");
        if (!state) throw new Error("Copilot inbox projection is unavailable");
        return state as InboxState;
      },
      this.events,
    );
    this.turn =
      this.ctx.sessionProjections.stateOf(session, "turnBoundary")?.lastTurn ??
      0;
  }

  get signal() {
    return this.controller?.signal;
  }

  permissions() {
    const approval =
      this.ctx.approval.overrideOf(this.session) ??
      this.ctx.approval.config.policy ??
      "ask";
    const sandbox = this.ctx
      .get("sandboxPolicy")
      ?.resolve({ session: this.session }).mode;
    const fullAccess =
      this.permission !== "deny" &&
      sandbox === "danger-full-access" &&
      approval === "never";
    const behavior =
      this.permission === "deny"
        ? "The Copilot driver rejects all tool permission requests."
        : fullAccess
          ? "Full access is enabled: the Copilot driver automatically approves tool permission requests without prompting. Here, never means no approval prompts, not that tool execution is forbidden. Use tools normally; do not request sandbox escalation."
          : approval === "never"
            ? "Tool permission requests are rejected automatically. Never alone does not grant full access."
            : "Tool permission requests go through DSH approval answerers; missing answerers fail closed.";
    return {
      fullAccess,
      context: [
        "[Current DSH Copilot permissions]",
        "This is permission context, not a task. It supersedes earlier DSH permission notices.",
        `Sandbox mode: ${sandbox ?? "not configured"}. Approval policy: ${approval}.`,
        behavior,
        "DSH sandbox modes are not enforced by Copilot tools. These settings do not override Copilot runtime or organization restrictions.",
      ].join("\n"),
    };
  }

  start() {
    this.ready = true;
    if (this.inbox.hasPending) this.wake();
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean) {
    if (this.disposed) throw new Error("Copilot agent is disposed");
    if (message.content.some((block) => block.type !== "text")) {
      throw new Error(
        "This Copilot driver currently accepts text prompts only",
      );
    }
    this.inbox.append(target, message);
    if (wakeup) this.wake();
  }

  followup(message: UserMessage) {
    this.send(message, "next-turn", true);
  }

  steer(message: UserMessage) {
    // The SDK owns its internal model boundaries; steering is queued for the next prompt.
    this.send(message, "next-step", true);
  }

  inject(message: UserMessage) {
    this.send(message, "next-step", false);
  }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}) {
    if (cause.kind === "disposed") this.disposed = true;
    if (!options.keepInbox) this.inbox.clear();
    this.controller?.abort(cause);
  }

  async whenIdle(): Promise<void> {
    while (this.active) await this.active;
    if (this.failure) throw this.failure;
  }

  async runMaintenance<T>(
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.active || this.maintenance)
      throw new Error("Copilot agent is busy");
    const controller = new AbortController();
    this.controller = controller;
    this.maintenance = true;
    const job = Promise.resolve().then(() => task(controller.signal));
    this.active = job.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await job;
    } finally {
      this.active = undefined;
      this.controller = undefined;
      this.maintenance = false;
      if (this.inbox.hasPending) this.wake();
    }
  }

  private wake() {
    if (!this.ready || this.disposed || this.active || this.maintenance) return;
    this.failure = undefined;
    this.status = "running";
    this.events.emit("agent/status", { status: this.status });
    const job = Promise.resolve().then(() =>
      this.ctx.agents.withInitiator(this, () => this.drain()),
    );
    this.active = job
      .catch((error: unknown) => {
        this.failure = error;
        this.ctx.logger.error("Copilot driver failed: %s", error);
      })
      .finally(() => {
        this.active = undefined;
        this.status = "idle";
        this.events.emit("agent/status", { status: this.status });
        if (!this.failure && this.inbox.hasPending) this.wake();
      });
  }

  private selection(): ModelSelection {
    const values = this.ctx.sessionProjections.snapshot(this.session)
      .values as {
      modelSelection?: { next: ModelSelection | null };
    };
    const selected = values.modelSelection?.next;
    const logged = this.session.requestHeader()?.config;
    const result = selected ?? logged ?? this.options;
    if (result.provider !== PROVIDER || !result.model) {
      throw new Error("Select a model from the Copilot CLI provider");
    }
    return {
      provider: PROVIDER,
      model: result.model,
      ...(result.reasoningEffort
        ? { reasoningEffort: result.reasoningEffort }
        : {}),
    };
  }

  private async drain() {
    while (!this.disposed && this.inbox.hasPending) {
      const controller = new AbortController();
      this.controller = controller;
      const turn = ++this.turn;
      this.session.append("turn/start", { turn });
      const messages = this.inbox.claim(turn);
      let reason: TurnEndReason = { kind: "completed" };
      let transcript: Transcript | undefined;
      let unsubscribe: (() => void) | undefined;
      let stepOpen = false;
      try {
        this.session.append("step/start", { turn, step: 1 });
        stepOpen = true;
        for (const message of messages) {
          this.session.append("user/message", message, { surfaceOp: "append" });
        }
        const remote = this.remote;
        if (!remote) throw new Error("Copilot session is not connected");
        const selection = this.selection();
        const cwd =
          this.ctx.get("workingDirectory")?.get(this.session) ??
          this.session.header.cwd;
        if (cwd && cwd !== this.cwd) {
          await remote.rpc.metadata.setWorkingDirectory({
            workingDirectory: cwd,
          });
          this.cwd = cwd;
        }
        controller.signal.throwIfAborted();
        const effort = reasoningEffort(selection.reasoningEffort);
        await remote.setModel(selection.model, {
          reasoningEffort: effort,
        });
        controller.signal.throwIfAborted();
        this.session.append("request/header", {
          header: { config: selection },
          reason: this.session.requestHeader() ? "change" : "initial",
        });
        function reasoningEffort(value?: string) {
          switch (value) {
            case undefined:
            case "low":
            case "medium":
            case "high":
            case "xhigh":
            case "max":
              return value;
            default:
              throw new Error(`Unsupported Copilot reasoning effort: ${value}`);
          }
        }
        transcript = new Transcript(
          this.session,
          this.events,
          turn,
          selection.model,
        );
        unsubscribe = remote.on((event) => {
          try {
            transcript!.accept(event);
          } catch (error) {
            transcript!.error =
              error instanceof Error ? error : new Error(String(error));
            controller.abort({
              kind: "hook",
              reason: "Transcript projection failed",
            });
          }
        });
        const abort = () => {
          void remote.abort().catch((error: unknown) => {
            this.ctx.logger.warn("Copilot abort failed: %s", error);
          });
        };
        controller.signal.addEventListener("abort", abort, { once: true });
        try {
          const text = messages
            .flatMap((message) =>
              message.source.kind === "user-approval"
                ? [
                    "The user changed the DSH permission settings. The current effective settings are stated above. This notice does not request any action.",
                  ]
                : message.content.map((block) =>
                    block.type === "text" ? block.text : "",
                  ),
            )
            .join("\n\n");
          const prompt = `${this.permissions().context}\n\n${text}`;
          await remote.sendAndWait({ prompt }, this.timeoutMs);
          if (transcript.error) throw transcript.error;
          controller.signal.throwIfAborted();
        } catch (error) {
          await remote.abort();
          throw error;
        } finally {
          controller.signal.removeEventListener("abort", abort);
        }
      } catch (error) {
        if (controller.signal.aborted && !transcript?.error) {
          reason = {
            kind: "aborted",
            reason: controller.signal.reason as AgentCancelCause,
          };
        } else {
          reason = {
            kind: "error",
            error: {
              code: "COPILOT_RUNTIME_ERROR",
              message: error instanceof Error ? error.message : String(error),
            },
          };
        }
      } finally {
        unsubscribe?.();
        transcript?.finish(reason.kind !== "completed");
        if (stepOpen && !transcript)
          this.session.append("step/end", { turn, step: 1 });
        this.session.append("turn/end", { turn, reason });
        this.controller = undefined;
      }
    }
  }
}
