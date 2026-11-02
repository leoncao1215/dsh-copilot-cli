var __addDisposableResource = (this && this.__addDisposableResource) || function (env, value, async) {
    if (value !== null && value !== void 0) {
        if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
        var dispose, inner;
        if (async) {
            if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
            dispose = value[Symbol.asyncDispose];
        }
        if (dispose === void 0) {
            if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
            dispose = value[Symbol.dispose];
            if (async) inner = dispose;
        }
        if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
        if (inner) dispose = function() { try { inner.call(this); } catch (e) { return Promise.reject(e); } };
        env.stack.push({ value: value, dispose: dispose, async: async });
    }
    else if (async) {
        env.stack.push({ async: true });
    }
    return value;
};
var __disposeResources = (this && this.__disposeResources) || (function (SuppressedError) {
    return function (env) {
        function fail(e) {
            env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
            env.hasError = true;
        }
        var r, s = 0;
        function next() {
            while (r = env.stack.pop()) {
                try {
                    if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
                    if (r.dispose) {
                        var result = r.dispose.call(r.value);
                        if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) { fail(e); return next(); });
                    }
                    else s |= 1;
                }
                catch (e) {
                    fail(e);
                }
            }
            if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
            if (env.hasError) throw env.error;
        }
        return next();
    };
})(typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
    var e = new Error(message);
    return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
import { Context } from "@deepseek-ai/cordis";
import { turnBoundaryProjectionDefinition } from "@deepseek-ai/dsh-agent-loop";
import { SessionPreparation, SessionLogOffset, interruptedTurnClosers, } from "@deepseek-ai/dsh-session";
import Schema from "@deepseek-ai/schemastery";
import { CopilotAgent } from "./agent.js";
import { CopilotCatalog } from "./catalog.js";
import { inboxProjection } from "./inbox.js";
import { PROVIDER, copilotSessionId, createRuntime, } from "./runtime.js";
export { CopilotAgent } from "./agent.js";
export { copilotSessionId } from "./runtime.js";
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
export const Config = Schema.object({
    cliPath: Schema.string().default("copilot"),
    model: Schema.string().default("auto"),
    permission: Schema.union(["ask", "deny"]).default("ask"),
    turnTimeoutMs: Schema.number().min(1000).default(1_800_000),
});
export class CopilotDriver {
    ctx;
    config;
    runtime;
    handles = new Set();
    pending = new Set();
    teardown = new AbortController();
    constructor(ctx, config, runtime) {
        this.ctx = ctx;
        this.config = config;
        this.runtime = runtime;
    }
    createAgent(owner, options) {
        if (options.seed?.length || options.meta?.isSeeded) {
            return Promise.reject(new Error("Forking dsh history into a Copilot session is not supported yet"));
        }
        return this.track(async () => {
            const env_1 = { stack: [], error: void 0, hasError: false };
            try {
                const preparation = __addDisposableResource(env_1, SessionPreparation.create(this.ctx.sessions.prepare(options.sessionId, {
                    meta: options.meta,
                })), false);
                const stored = await this.ctx.sessionPersistence.create(preparation.session.header, { signal: options.signal });
                return this.initialize(owner, preparation.session, stored, options, false);
            }
            catch (e_1) {
                env_1.error = e_1;
                env_1.hasError = true;
            }
            finally {
                __disposeResources(env_1);
            }
        });
    }
    resume(owner, options) {
        return this.track(async () => {
            const stored = await this.ctx.sessionPersistence.open(options.resumeSessionId, "write", { signal: options.signal });
            try {
                const env_2 = { stack: [], error: void 0, hasError: false };
                try {
                    const read = await stored.read(0, undefined, {
                        signal: options.signal,
                    });
                    const closers = interruptedTurnClosers(read.events);
                    if (closers.length)
                        await stored.append(closers);
                    const preparation = __addDisposableResource(env_2, SessionPreparation.create(this.ctx.sessions.prepare(options.resumeSessionId, {
                        seed: [...read.events, ...closers],
                        meta: structuredClone(stored.header),
                        inheritedEventCount: stored.inheritedEventCount,
                        eventState: read.eventState,
                    })), false);
                    return await this.initialize(owner, preparation.session, stored, options, true, read.events.length + closers.length);
                }
                catch (e_2) {
                    env_2.error = e_2;
                    env_2.hasError = true;
                }
                finally {
                    __disposeResources(env_2);
                }
            }
            catch (error) {
                await stored.close();
                throw error;
            }
        });
    }
    track(operation) {
        if (this.teardown.signal.aborted)
            return Promise.reject(new Error("Copilot driver is disposed"));
        const job = Promise.resolve().then(operation);
        this.pending.add(job);
        void job.finally(() => this.pending.delete(job)).catch(() => { });
        return job;
    }
    async initialize(owner, session, stored, options, resume, storedCount = 0) {
        const agent = new CopilotAgent(this.ctx, session, {
            ...options.agentOptions,
            provider: PROVIDER,
            model: options.agentOptions?.provider === PROVIDER
                ? (options.agentOptions.model ?? this.config.model)
                : this.config.model,
        }, this.config.turnTimeoutMs, this.config.permission);
        const startup = new AbortController();
        const signal = AbortSignal.any([
            startup.signal,
            this.teardown.signal,
            ...(options.signal ? [options.signal] : []),
        ]);
        let detachAgent;
        let detachSession;
        let disposing;
        let releaseOwner;
        const initialized = Promise.withResolvers();
        const handle = {
            agent,
            dispose: () => (disposing ??= (async () => {
                startup.abort();
                await initialized.promise;
                const failures = [];
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
                    }
                    catch (error) {
                        failures.push(error);
                    }
                }
                this.handles.delete(handle);
                if (failures.length)
                    throw new AggregateError(failures, "Copilot session cleanup failed");
            })()),
        };
        this.handles.add(handle);
        try {
            releaseOwner = owner.effect(() => () => {
                if (!disposing)
                    return handle.dispose();
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
            if (suffix.length)
                await stored.append(suffix);
            detachSession = agent.ctx.sessions.enter(session);
            agent.ctx.sessions.announce(session);
            detachAgent = this.ctx.agents.enter(agent, options.parentAgent);
            await this.ctx.agents.announce(agent, resume ? "resume" : "startup", signal);
            signal.throwIfAborted();
            agent.start();
            initialized.resolve();
            return handle;
        }
        catch (error) {
            initialized.resolve();
            await handle.dispose().catch(() => { });
            throw error;
        }
    }
    sessionConfig(agent) {
        return {
            workingDirectory: this.ctx.get("workingDirectory")?.get(agent.session) ??
                agent.session.header.cwd ??
                process.cwd(),
            model: agent.options.model,
            streaming: true,
            includeSubAgentStreamingEvents: false,
            onPermissionRequest: async (request) => {
                if (this.config.permission === "deny" ||
                    agent.signal?.aborted ||
                    agent.status !== "running")
                    return { kind: "reject" };
                if (agent.permissions().fullAccess)
                    return { kind: "approve-once" };
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
        const live = await Promise.allSettled([...this.handles].map((handle) => handle.dispose()));
        await this.runtime.stop();
        const failures = [...pending, ...live].filter((result) => result.status === "rejected");
        if (failures.length)
            throw new AggregateError(failures.map((result) => result.reason), "Copilot driver cleanup failed");
    }
}
export async function apply(ctx, config) {
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
