import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  createUserMessage,
  joinAssistantStreamText,
} from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import type {
  SessionConfig,
  ResumeSessionConfig,
  SessionEvent,
} from "@github/copilot-sdk";
import {
  copilotSessionId,
  type Runtime,
  type RuntimeSession,
} from "../src/runtime.js";
import { harness } from "./helpers.js";

function prompt(text: string) {
  return createUserMessage({
    content: [{ type: "text", text }],
    source: { kind: "user" },
  });
}

class FakeSession {
  readonly listeners = new Set<(event: SessionEvent) => void>();
  readonly prompts: string[] = [];
  readonly models: string[] = [];
  disconnected = false;
  aborted = 0;
  send = async (session: FakeSession) => {
    session.emit("assistant.message", {
      messageId: randomUUID(),
      content: "done",
    });
  };
  on = (listener: (event: SessionEvent) => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  emit(type: string, data: object) {
    const event = {
      type,
      data,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      parentId: null,
    } as SessionEvent;
    for (const listener of this.listeners) listener(event);
  }
  async sendAndWait(options: { prompt: string }) {
    this.prompts.push(options.prompt);
    await this.send(this);
  }
  async setModel(model: string) {
    this.models.push(model);
  }
  async abort() {
    this.aborted++;
  }
  async disconnect() {
    this.disconnected = true;
  }
  rpc = {
    metadata: {
      setWorkingDirectory: async (input: { workingDirectory: string }) => input,
    },
  };
}

class FakeRuntime implements Runtime {
  readonly sessions = new Map<string, FakeSession>();
  readonly configs: SessionConfig[] = [];
  readonly resumed: string[] = [];
  async start() {}
  async stop() {}
  async listModels() {
    return [];
  }
  async createSession(config: SessionConfig): Promise<RuntimeSession> {
    this.configs.push(config);
    const session = new FakeSession();
    this.sessions.set(config.sessionId!, session);
    return session as unknown as RuntimeSession;
  }
  async resumeSession(
    id: string,
    _config: ResumeSessionConfig,
  ): Promise<RuntimeSession> {
    this.resumed.push(id);
    const session = this.sessions.get(id);
    if (!session) throw new Error("Missing Copilot session");
    session.disconnected = false;
    return session as unknown as RuntimeSession;
  }
}

async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "dsh-copilot-test-"));
  const runtime = new FakeRuntime();
  const app = await harness(root, runtime);
  t.after(async () => {
    await app.dispose();
    await rm(root, { recursive: true, force: true });
  });
  return { ...app, runtime, root };
}

test("projects streamed text and tool results, persists history, and resumes the same Copilot session", async (t) => {
  const { ctx, runtime } = await fixture(t);
  const id = SessionId(randomUUID());
  const handle = await ctx.agents.create({
    sessionId: id,
    meta: { cwd: process.cwd() },
  });
  const remote = runtime.sessions.get(copilotSessionId(id))!;
  remote.send = async (session) => {
    session.emit("assistant.message_delta", {
      messageId: "m1",
      deltaContent: "checking",
    });
    session.emit("assistant.message", {
      messageId: "m1",
      content: "checking",
      toolRequests: [
        {
          toolCallId: "t1",
          name: "read_file",
          arguments: { path: "README.md" },
        },
      ],
    });
    session.emit("tool.execution_start", {
      toolCallId: "t1",
      toolName: "read_file",
      arguments: { path: "README.md" },
    });
    session.emit("tool.execution_complete", {
      toolCallId: "t1",
      success: true,
      result: { content: "file contents" },
    });
    session.emit("assistant.message", { messageId: "m2", content: "finished" });
  };
  handle.agent.followup(prompt("inspect"));
  await handle.agent.whenIdle();
  const before = handle.agent.session.snapshotEvents();
  const messages = before.filter((event) => event.type === "assistant/message");
  assert.deepEqual(
    messages.map((event) => joinAssistantStreamText(event.data.stream)),
    ["checking", "finished"],
  );
  assert.equal(before.filter((event) => event.type === "tool/call").length, 1);
  assert.equal(
    before.filter((event) => event.type === "tool/result").length,
    1,
  );
  assert.equal(before.at(-1)?.type, "turn/end");
  await handle.dispose();
  assert.equal(remote.disconnected, true);
  const resumed = await ctx.agents.resume({ resumeSessionId: id });
  assert.deepEqual(runtime.resumed, [copilotSessionId(id)]);
  assert.deepEqual(
    resumed.agent.session.snapshotEvents().slice(0, before.length),
    before,
  );
  resumed.agent.followup(prompt("continue"));
  await resumed.agent.whenIdle();
  assert.deepEqual(remote.prompts, ["inspect", "continue"]);
  const turns = resumed.agent.session
    .snapshotEvents()
    .filter((event) => event.type === "turn/start");
  assert.deepEqual(
    turns.map((event) => event.data.turn),
    [1, 2],
  );
});

test("isolates sessions and serializes queued prompts within a session", async (t) => {
  const { ctx, runtime } = await fixture(t);
  const a = await ctx.agents.create({
    sessionId: SessionId(randomUUID()),
    meta: { cwd: process.cwd() },
  });
  const b = await ctx.agents.create({
    sessionId: SessionId(randomUUID()),
    meta: { cwd: tmpdir() },
  });
  const first = runtime.sessions.get(copilotSessionId(a.agent.id))!;
  const second = runtime.sessions.get(copilotSessionId(b.agent.id))!;
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  first.send = async (session) => {
    if (session.prompts.length === 1) {
      started.resolve();
      await release.promise;
    }
    session.emit("assistant.message", {
      messageId: randomUUID(),
      content: "a",
    });
  };
  a.agent.followup(prompt("a1"));
  a.agent.followup(prompt("a2"));
  await started.promise;
  b.agent.followup(prompt("b1"));
  await b.agent.whenIdle();
  assert.deepEqual(first.prompts, ["a1"]);
  assert.deepEqual(second.prompts, ["b1"]);
  release.resolve();
  await a.agent.whenIdle();
  assert.deepEqual(first.prompts, ["a1", "a2"]);
  assert.equal(runtime.configs[0].workingDirectory, process.cwd());
  assert.equal(runtime.configs[1].workingDirectory, tmpdir());
});

test("cancellation retains streamed output and closes unfinished tools", async (t) => {
  const { ctx, runtime } = await fixture(t);
  const handle = await ctx.agents.create({
    sessionId: SessionId(randomUUID()),
  });
  const remote = runtime.sessions.get(copilotSessionId(handle.agent.id))!;
  const started = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  remote.abort = async () => {
    remote.aborted++;
    stopped.resolve();
  };
  remote.send = async (session) => {
    session.emit("assistant.message_delta", {
      messageId: "partial",
      deltaContent: "partial answer",
    });
    session.emit("tool.execution_start", {
      toolCallId: "unfinished",
      toolName: "shell",
    });
    started.resolve();
    await stopped.promise;
  };
  handle.agent.followup(prompt("work"));
  await started.promise;
  handle.agent.cancel({ kind: "user" });
  await handle.agent.whenIdle();
  const events = handle.agent.session.snapshotEvents();
  const end = events.findLast((event) => event.type === "turn/end");
  assert.equal(end?.data.reason.kind, "aborted");
  assert.equal(
    events.find((event) => event.type === "assistant/message")?.data
      .interrupted,
    true,
  );
  assert.equal(
    events.find((event) => event.type === "tool/result")?.data.message.isError,
    true,
  );
  assert.equal(remote.listeners.size, 0);
});

test("rejects permission requests outside a running turn", async (t) => {
  const { ctx, runtime } = await fixture(t);
  const handle = await ctx.agents.create({
    sessionId: SessionId(randomUUID()),
  });
  const callback = runtime.configs[0].onPermissionRequest!;
  const decision = await callback({ kind: "read" } as never, {
    sessionId: handle.agent.id,
  });
  assert.deepEqual(decision, { kind: "reject" });
});

test("forwards active permission decisions and fails closed without an answerer", async (t) => {
  const { ctx, runtime } = await fixture(t);
  const handle = await ctx.agents.create({
    sessionId: SessionId(randomUUID()),
  });
  const remote = runtime.sessions.get(copilotSessionId(handle.agent.id))!;
  const callback = runtime.configs[0].onPermissionRequest!;
  const decisions: unknown[] = [];
  remote.send = async () => {
    decisions.push(
      await callback({ kind: "read" } as never, { sessionId: handle.agent.id }),
    );
  };
  handle.agent.followup(prompt("unattended"));
  await handle.agent.whenIdle();
  const release = ctx.on("approval/request", async () => "allowed-once");
  handle.agent.followup(prompt("approved"));
  await handle.agent.whenIdle();
  release();
  const reject = ctx.on("approval/request", async () => "rejected");
  handle.agent.followup(prompt("rejected"));
  await handle.agent.whenIdle();
  reject();
  assert.deepEqual(decisions, [
    { kind: "reject" },
    { kind: "approve-once", approvedInteractively: true },
    { kind: "reject" },
  ]);
  const outcomes = handle.agent.session
    .snapshotEvents()
    .filter((event) => event.type === "approval/decided")
    .map((event) => event.data.outcome);
  assert.deepEqual(outcomes, ["unavailable", "allowed-once", "rejected"]);
});

test("drains late Copilot creation when its owner is disposed before publication", async (t) => {
  const { ctx, runtime, driver } = await fixture(t);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const create = runtime.createSession.bind(runtime);
  runtime.createSession = async (config) => {
    started.resolve();
    await release.promise;
    return create(config);
  };
  const id = SessionId(randomUUID());
  let creation!: Promise<unknown>;
  const owner = await ctx.plugin({
    name: "test-session-owner",
    apply(context) {
      creation = driver.createAgent(context, { sessionId: id });
    },
  });
  const rejected = assert.rejects(creation, /abort/i);
  await started.promise;
  const disposal = owner.dispose();
  release.resolve();
  await rejected;
  await disposal;
  assert.equal(runtime.sessions.get(copilotSessionId(id))?.disconnected, true);
  assert.equal(ctx.agents.get(id), undefined);
  assert.equal(ctx.sessions.get(id), undefined);
});

test("keeps the user prompt visible when model preflight fails", async (t) => {
  const { ctx, runtime } = await fixture(t);
  const handle = await ctx.agents.create({
    sessionId: SessionId(randomUUID()),
  });
  const remote = runtime.sessions.get(copilotSessionId(handle.agent.id))!;
  remote.setModel = async () => {
    throw new Error("model unavailable");
  };
  handle.agent.followup(prompt("keep this prompt"));
  await handle.agent.whenIdle();
  const events = handle.agent.session.snapshotEvents();
  assert.equal(
    events.filter((event) => event.type === "user/message").length,
    1,
  );
  assert.equal(
    events.findLast((event) => event.type === "turn/end")?.data.reason.kind,
    "error",
  );
  assert.deepEqual(remote.prompts, []);
});

test("rolls back failed setup without publishing a session or starting Copilot", async (t) => {
  const { ctx, runtime } = await fixture(t);
  const id = SessionId(randomUUID());
  await assert.rejects(
    ctx.agents.create({
      sessionId: id,
      setup() {
        throw new Error("setup failed");
      },
    }),
    /setup failed/,
  );
  assert.equal(ctx.agents.get(id), undefined);
  assert.equal(ctx.sessions.get(id), undefined);
  assert.equal(runtime.sessions.size, 0);
});

test("rejects unsupported attachments and history forks rather than silently dropping them", async (t) => {
  const { ctx } = await fixture(t);
  await assert.rejects(
    ctx.agents.create({
      sessionId: SessionId(randomUUID()),
      meta: { isSeeded: true },
    }),
    /not supported/,
  );
  const handle = await ctx.agents.create({
    sessionId: SessionId(randomUUID()),
  });
  const message = { ...prompt("text"), content: [{ type: "image" }] } as never;
  assert.throws(() => handle.agent.followup(message), /text prompts only/);
  assert.equal(handle.agent.inbox.nextTurn.length, 0);
});

test("records runtime errors as failed turns and releases event subscriptions", async (t) => {
  const { ctx, runtime } = await fixture(t);
  const handle = await ctx.agents.create({
    sessionId: SessionId(randomUUID()),
  });
  const remote = runtime.sessions.get(copilotSessionId(handle.agent.id))!;
  remote.send = async (session) => {
    session.emit("session.error", { message: "runtime failed" });
  };
  handle.agent.followup(prompt("fail"));
  await handle.agent.whenIdle();
  const end = handle.agent.session
    .snapshotEvents()
    .findLast((event) => event.type === "turn/end");
  assert.equal(end?.data.reason.kind, "error");
  assert.equal(remote.listeners.size, 0);
});
