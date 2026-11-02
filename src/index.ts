import { Context } from "@deepseek-ai/cordis";
import type {
  AgentFactory,
  AgentHandle,
  AgentSetup,
  Agent,
  CreateAgentOptions,
  ResumeAgentOptions,
} from "@deepseek-ai/dsh-agent";
import { turnBoundaryProjectionDefinition } from "@deepseek-ai/dsh-agent-loop";
import {
  SessionPreparation,
  SessionLogOffset,
  interruptedTurnClosers,
  type Session,
} from "@deepseek-ai/dsh-session";
import type { SessionHandle } from "@deepseek-ai/dsh-session-persistence";
import type {} from "@deepseek-ai/dsh-session-projection";
import type {} from "@deepseek-ai/dsh-user-approval";
import type {} from "@deepseek-ai/dsh-user-questions";
import Schema from "@deepseek-ai/schemastery";
import type { SessionConfigBase } from "@github/copilot-sdk";
import { CopilotAgent } from "./agent.js";
import { CopilotCatalog } from "./catalog.js";
import { inboxProjection } from "./inbox.js";
import {
  PROVIDER,
  copilotSessionId,
  createRuntime,
  type Runtime,
} from "./runtime.js";

export { CopilotAgent } from "./agent.js";
export { copilotSessionId } from "./runtime.js";

export interface Config {
  cliPath: string;
  model: string;
  permission: "ask" | "deny";
  turnTimeoutMs: number;
}

export const name = "dsh-agent-copilot";
export const inject = [
  "agents",
  "sessions",
  "sessionProjections",
  "sessionPersistence",
  "llm",
  "approval",
  "userQuestions",
];
export const Config: Schema<Config> = Schema.object({
  cliPath: Schema.string().default("copilot"),
  model: Schema.string().default("auto"),
  permission: Schema.union(["ask", "deny"]).default("ask"),
  turnTimeoutMs: Schema.number().min(1000).default(1_800_000),
});

export class CopilotDriver implements AgentFactory {
  private readonly handles = new Set<AgentHandle>();
  private readonly pending = new Set<Promise<AgentHandle>>();
  private readonly teardown = new AbortController();

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly runtime: Runtime,
  ) {}

  createAgent(
    owner: Context,
    options: CreateAgentOptions,
  ): Promise<AgentHandle> {
    if (options.seed?.length || options.meta?.isSeeded) {
      return Promise.reject(
        new Error(
          "Forking dsh history into a Copilot session is not supported yet",
        ),
      );
    }
    return this.track(async () => {
      using preparation = SessionPreparation.create(
        this.ctx.sessions.prepare(options.sessionId, {
          meta: options.meta,
        }),
      );
      const stored = await this.ctx.sessionPersistence.create(
        preparation.session.header,
        { signal: options.signal },
      );
      return this.initialize(
        owner,
        preparation.session,
        stored,
        options,
        false,
      );
    });
  }

  resume(owner: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    return this.track(async () => {
      const stored = await this.ctx.sessionPersistence.open(
        options.resumeSessionId,
        "write",
        { signal: options.signal },
      );
      try {
        const read = await stored.read(0, undefined, {
          signal: options.signal,
        });
        const closers = interruptedTurnClosers(read.events);
        if (closers.length) await stored.append(closers);
        using preparation = SessionPreparation.create(
          this.ctx.sessions.prepare(options.resumeSessionId, {
            seed: [...read.events, ...closers],
            meta: structuredClone(stored.header),
            inheritedEventCount: stored.inheritedEventCount,
            eventState: read.eventState,
          }),
        );
        return await this.initialize(
          owner,
          preparation.session,
          stored,
          options,
          true,
          read.events.length + closers.length,
        );
      } catch (error) {
        await stored.close();
        throw error;
      }
    });
  }

  private track(operation: () => Promise<AgentHandle>): Promise<AgentHandle> {
    if (this.teardown.signal.aborted)
      return Promise.reject(new Error("Copilot driver is disposed"));
    const job = Promise.resolve().then(operation);
    this.pending.add(job);
    void job.finally(() => this.pending.delete(job)).catch(() => {});
    return job;
  }

  private async initialize(
    owner: Context,
    session: Session,
    stored: SessionHandle,
    options: {
      agentOptions?: CreateAgentOptions["agentOptions"];
      setup?: AgentSetup;
      signal?: AbortSignal;
      parentAgent?: Agent;
    },
    resume: boolean,
    storedCount = 0,
  ): Promise<AgentHandle> {
    const agent = new CopilotAgent(
      this.ctx,
      session,
      {
        ...options.agentOptions,
        provider: PROVIDER,
        model:
          options.agentOptions?.provider === PROVIDER
            ? (options.agentOptions.model ?? this.config.model)
            : this.config.model,
      },
      this.config.turnTimeoutMs,
      this.config.permission,
    );
    const startup = new AbortController();
    const signal = AbortSignal.any([
      startup.signal,
      this.teardown.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    let detachAgent: (() => void) | undefined;
    let detachSession: (() => void) | undefined;
    let disposing: Promise<void> | undefined;
    let releaseOwner: (() => void | Promise<void>) | undefined;
    const initialized = Promise.withResolvers<void>();
    const handle: AgentHandle = {
      agent,
      dispose: () =>
        (disposing ??= (async () => {
          startup.abort();
          await initialized.promise;
          const failures: unknown[] = [];
          for (const release of [
            async () => {
              agent.cancel({ kind: "disposed" }, { keepInbox: true });
              await agent.whenIdle();
            },
            async () => {
              await agent.remote?.disconnect();
            },
            async () => {
              await stored.close();
            },
            async () => {
              detachAgent?.();
              detachSession?.();
            },
            async () => {
              await agent.scope.dispose();
            },
            async () => {
              await releaseOwner?.();
            },
          ]) {
            try {
              await release();
            } catch (error) {
              failures.push(error);
            }
          }
          this.handles.delete(handle);
          if (failures.length)
            throw new AggregateError(
              failures,
              "Copilot session cleanup failed",
            );
        })()),
    };
    this.handles.add(handle);
    try {
      releaseOwner = owner.effect(() => () => {
        if (!disposing) return handle.dispose();
      });
      signal.throwIfAborted();
      owner.fiber.assertActive();
      const commit = await options.setup?.(agent.ctx, agent);
      signal.throwIfAborted();
      const remoteConfig = this.sessionConfig(agent);
      const id = copilotSessionId(session.id);
      agent.remote = resume
        ? await this.runtime.resumeSession(id, remoteConfig)
        : await this.runtime.createSession({
            ...remoteConfig,
            sessionId: id,
            name: `dsh ${session.id}`.slice(0, 100),
          });
      signal.throwIfAborted();
      commit?.commit();
      const suffix = session.snapshotEvents(SessionLogOffset(storedCount));
      if (suffix.length) await stored.append(suffix);
      detachSession = agent.ctx.sessions.enter(session);
      agent.ctx.sessions.announce(session);
      detachAgent = this.ctx.agents.enter(agent, options.parentAgent);
      await this.ctx.agents.announce(
        agent,
        resume ? "resume" : "startup",
        signal,
      );
      signal.throwIfAborted();
      agent.start();
      initialized.resolve();
      return handle;
    } catch (error) {
      initialized.resolve();
      await handle.dispose().catch(() => {});
      throw error;
    }
  }

  private sessionConfig(agent: CopilotAgent): SessionConfigBase {
    return {
      workingDirectory:
        this.ctx.get("workingDirectory")?.get(agent.session) ??
        agent.session.header.cwd ??
        process.cwd(),
      model: agent.options.model,
      streaming: true,
      reasoningSummary: "detailed",
      includeSubAgentStreamingEvents: true,
      onPermissionRequest: async (request) => {
        if (
          this.config.permission === "deny" ||
          agent.signal?.aborted ||
          agent.status !== "running"
        )
          return { kind: "reject" };
        if (agent.permissions().fullAccess) return { kind: "approve-once" };
        const outcome = await this.ctx.approval.request({
          agent,
          toolName: `copilot:${request.kind}`,
          reason: JSON.stringify(request),
          signal: agent.signal,
        });
        return outcome === "allowed-once"
          ? { kind: "approve-once", approvedInteractively: true }
          : { kind: "reject" };
      },
      onUserInputRequest: async (request) => {
        const answer = await this.ctx.userQuestions.ask({
          agent,
          signal: agent.signal,
          questions: [
            {
              id: "copilot",
              question: request.question,
              options: request.choices?.map((label) => ({ label })),
            },
          ],
        });
        const item = answer.answers[0];
        return {
          answer: item?.custom ?? item?.selected.join(", ") ?? "",
          wasFreeform: !!item?.custom,
        };
      },
    };
  }

  async dispose() {
    this.teardown.abort();
    const pending = await Promise.allSettled([...this.pending]);
    const live = await Promise.allSettled(
      [...this.handles].map((handle) => handle.dispose()),
    );
    await this.runtime.stop();
    const failures = [...pending, ...live].filter(
      (result) => result.status === "rejected",
    );
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "Copilot driver cleanup failed",
      );
  }
}

export async function apply(ctx: Context, config: Config) {
  const runtime = createRuntime(config.cliPath);
  const driver = new CopilotDriver(ctx, config, runtime);
  ctx.effect(() => async () => {
    await runtime.stop();
  });
  await runtime.start();
  ctx.sessionProjections.register(inboxProjection);
  ctx.sessionProjections.register(turnBoundaryProjectionDefinition);
  ctx.llm.registerAdapter([PROVIDER], new CopilotCatalog(runtime));
  ctx.agents.setFactory(driver);
  ctx.effect(() => () => driver.dispose());
}
