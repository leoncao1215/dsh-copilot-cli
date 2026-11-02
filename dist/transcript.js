import { randomUUID } from "node:crypto";
import { AssistantStreamAccumulator, BlockAssembler, LlmAttemptId, ToolCallId, boundContextSummary, createDeveloperMessage, createToolResultMessage, } from "@deepseek-ai/dsh-llm";
import { SessionLogOffset, ToolCallRecovery, } from "@deepseek-ai/dsh-session";
import { PROVIDER } from "./runtime.js";
class Attempt {
    id = LlmAttemptId(randomUUID());
    stream = new AssistantStreamAccumulator();
    assembler = new BlockAssembler();
    index = 0;
    blocks = new Map();
    nextBlock = 0;
}
export class Transcript {
    session;
    events;
    turn;
    model;
    attempt;
    revision = 0;
    step = 1;
    stepOpen = true;
    settled = false;
    tools = new Set();
    pendingTools = new Set();
    advertisedTools = new Set();
    childTools = new Map();
    subagents = new Map();
    notices = new Map();
    childStreams = new Map();
    childReasoning = new Map();
    startOffset;
    error;
    constructor(session, events, turn, model) {
        this.session = session;
        this.events = events;
        this.turn = turn;
        this.model = model;
        this.startOffset = SessionLogOffset(session.seq);
    }
    openStep() {
        if (this.stepOpen)
            return;
        this.session.append("step/start", { turn: this.turn, step: ++this.step });
        this.stepOpen = true;
    }
    closeStep() {
        if (!this.stepOpen)
            return;
        this.session.append("step/end", { turn: this.turn, step: this.step });
        this.stepOpen = false;
        this.settled = false;
    }
    opening() {
        if (!this.attempt && this.settled)
            this.closeStep();
        this.openStep();
        if (!this.attempt) {
            this.attempt = new Attempt();
            this.events.emit("agent/assistant-stream", {
                frame: {
                    type: "start",
                    attemptId: this.attempt.id,
                    revision: (this.revision = this.session.seq + 1),
                    turn: this.turn,
                    step: this.step,
                },
            });
        }
        return this.attempt;
    }
    push(chunk) {
        const attempt = this.opening();
        const timed = attempt.stream.push({ time: Date.now(), chunk });
        attempt.assembler.push(timed.chunk);
        this.events.emit("agent/assistant-stream", {
            frame: {
                type: "chunk",
                attemptId: attempt.id,
                revision: this.revision,
                index: attempt.index++,
                ...timed,
            },
        });
    }
    block(key) {
        const attempt = this.opening();
        let block = attempt.blocks.get(key);
        if (!block) {
            block = { index: attempt.nextBlock++, text: "", closed: false };
            attempt.blocks.set(key, block);
        }
        return block;
    }
    append(key, text, type) {
        if (!text)
            return;
        const block = this.block(key);
        if (block.closed)
            return;
        block.text += text;
        this.push({
            type: type === "text" ? "text-delta" : "reasoning-delta",
            index: block.index,
            text,
        });
    }
    complete(key, text, type) {
        if (!text && !this.attempt?.blocks.has(key))
            return;
        const block = this.block(key);
        if (block.closed)
            return;
        if (text.startsWith(block.text)) {
            this.append(key, text.slice(block.text.length), type);
        }
        this.push({
            type: "block-end",
            index: block.index,
            block: { type, text },
        });
        block.text = text;
        block.closed = true;
    }
    notice(key, text) {
        if (!text.trim() || this.notices.get(key) === text)
            return;
        this.notices.set(key, text);
        this.progress(text);
    }
    progress(text) {
        this.openStep();
        this.session.append("developer/message", {
            turn: this.turn,
            step: this.step,
            message: createDeveloperMessage({
                content: [{ type: "text", text }],
                source: {
                    kind: "copilot-progress",
                    form: "notice",
                    summary: boundContextSummary(text.replace(/\s+/g, " ").trim()),
                },
            }),
        }, { surfaceOp: "append" });
    }
    reasoningFallback(text) {
        const blocks = [...(this.attempt?.blocks ?? [])].filter(([key]) => key.startsWith("reasoning:"));
        const previous = blocks.map(([, block]) => block.text).join("");
        if (previous === text)
            return;
        if (!previous) {
            this.complete("reasoning:fallback", text, "reasoning");
        }
        else if (text.startsWith(previous)) {
            this.complete("reasoning:fallback", text.slice(previous.length), "reasoning");
        }
        else if (blocks.length === 1 && !blocks[0][1].closed) {
            this.complete(blocks[0][0], text, "reasoning");
        }
    }
    childContent(key, text, label, complete = false) {
        let stream = this.childStreams.get(key);
        if (!stream) {
            stream = {
                text: "",
                pending: "",
                label,
                lastFlush: Date.now(),
                closed: false,
            };
            this.childStreams.set(key, stream);
        }
        if (stream.closed)
            return;
        if (complete) {
            if (text.startsWith(stream.text)) {
                stream.pending += text.slice(stream.text.length);
            }
            else {
                stream.pending = `[Updated content]\n${text}`;
            }
            stream.text = text;
            stream.closed = true;
        }
        else {
            stream.text += text;
            stream.pending += text;
        }
        if (stream.pending &&
            (complete ||
                stream.pending.includes("\n\n") ||
                stream.pending.length >= 512 ||
                Date.now() - stream.lastFlush >= 1000)) {
            this.progress(stream.label + stream.pending);
            stream.pending = "";
            stream.lastFlush = Date.now();
        }
    }
    accept(event) {
        const child = event.agentId ??
            ("parentToolCallId" in event.data
                ? event.data.parentToolCallId
                : undefined) ??
            ("toolCallId" in event.data && typeof event.data.toolCallId === "string"
                ? this.childTools.get(event.data.toolCallId)?.child
                : undefined);
        const label = child
            ? `Copilot subagent ${this.subagents.get(child) ?? child}`
            : "Copilot";
        if (child) {
            switch (event.type) {
                case "assistant.message_delta":
                    this.childContent(`child:${child}:message:${event.data.messageId}`, event.data.deltaContent, `[${label}: response]\n\n`);
                    return;
                case "assistant.reasoning_delta":
                case "assistant.reasoning": {
                    const key = `child:${child}:reasoning:${event.data.reasoningId}`;
                    if (this.childStreams.get(key)?.closed)
                        return;
                    const keys = this.childReasoning.get(child) ?? [];
                    if (!keys.includes(key))
                        keys.push(key);
                    this.childReasoning.set(child, keys);
                    this.childContent(key, event.type === "assistant.reasoning"
                        ? event.data.content
                        : event.data.deltaContent, `[${label}: reasoning]\n\n`, event.type === "assistant.reasoning");
                    return;
                }
                case "assistant.message": {
                    if (this.childStreams.get(`child:${child}:message:${event.data.messageId}`)?.closed)
                        return;
                    const keys = this.childReasoning.get(child) ?? [];
                    const previous = keys
                        .map((key) => this.childStreams.get(key).text)
                        .join("");
                    const reconcileSingle = keys.length === 1 && !this.childStreams.get(keys[0]).closed;
                    for (const key of keys)
                        this.childContent(key, reconcileSingle && event.data.reasoningText
                            ? event.data.reasoningText
                            : this.childStreams.get(key).text, `[${label}: reasoning]\n\n`, true);
                    if (!reconcileSingle &&
                        event.data.reasoningText?.startsWith(previous)) {
                        this.childContent(`child:${child}:reasoning:${event.data.messageId}`, event.data.reasoningText.slice(previous.length), `[${label}: reasoning]\n\n`, true);
                    }
                    this.childReasoning.delete(child);
                    this.childContent(`child:${child}:message:${event.data.messageId}`, event.data.content, `[${label}: response]\n\n`, true);
                    return;
                }
                case "session.error":
                    this.notice(`child:${child}:error`, `[${label}: error] ${event.data.message}`);
                    return;
                case "tool.execution_start":
                    this.childTools.set(event.data.toolCallId, {
                        child,
                        name: event.data.toolName,
                    });
                    this.notice(`tool:${event.data.toolCallId}`, `[${label} tool ${event.data.toolName}: started]`);
                    return;
                case "tool.execution_complete":
                    this.notice(`tool:${event.data.toolCallId}`, `[${label} tool ${this.childTools.get(event.data.toolCallId)?.name ?? event.data.toolCallId}: ${event.data.success ? "completed" : "failed"}]${event.data.error?.message ? ` ${event.data.error.message}` : ""}`);
                    this.childTools.delete(event.data.toolCallId);
                    return;
            }
        }
        switch (event.type) {
            case "assistant.message_delta":
                this.append("text", event.data.deltaContent, "text");
                break;
            case "assistant.reasoning_delta":
                this.append(`reasoning:${event.data.reasoningId}`, event.data.deltaContent, "reasoning");
                break;
            case "assistant.reasoning":
                this.complete(`reasoning:${event.data.reasoningId}`, event.data.content, "reasoning");
                break;
            case "assistant.intent":
                this.notice(`intent:${child ?? "root"}`, `[${label} activity] ${event.data.intent}`);
                break;
            case "subagent.started":
                this.subagents.set(event.data.toolCallId, event.data.agentDisplayName || event.data.agentName);
                this.notice(`subagent:${event.data.toolCallId}`, `[Copilot subagent ${event.data.agentDisplayName || event.data.agentName}: started] ${event.data.agentDescription}`);
                break;
            case "subagent.completed":
                this.notice(`subagent:${event.data.toolCallId}`, `[Copilot subagent ${event.data.agentDisplayName || event.data.agentName}: ${event.data.cancelled ? "cancelled" : "completed"}]`);
                break;
            case "subagent.failed":
                this.notice(`subagent:${event.data.toolCallId}`, `[Copilot subagent ${event.data.agentDisplayName || event.data.agentName}: failed] ${event.data.error}`);
                break;
            case "tool.execution_progress":
                this.notice(`tool:${event.data.toolCallId}`, `[${label} tool ${event.data.toolCallId}] ${event.data.progressMessage}`);
                break;
            case "assistant.message": {
                const { data } = event;
                if (data.reasoningText)
                    this.reasoningFallback(data.reasoningText);
                this.complete("text", data.content, "text");
                for (const tool of data.toolRequests ?? []) {
                    if (this.advertisedTools.has(tool.toolCallId))
                        continue;
                    this.advertisedTools.add(tool.toolCallId);
                    this.pendingTools.add(tool.toolCallId);
                    this.push({
                        type: "block-end",
                        index: this.block(`tool:${tool.toolCallId}`).index,
                        block: {
                            type: "tool-call",
                            id: ToolCallId(tool.toolCallId),
                            name: tool.name,
                            arguments: JSON.stringify(tool.arguments ?? {}),
                        },
                    });
                }
                this.commit(false);
                break;
            }
            case "tool.execution_start":
                if (this.tools.has(event.data.toolCallId))
                    break;
                this.openStep();
                if (!this.advertisedTools.has(event.data.toolCallId)) {
                    this.advertisedTools.add(event.data.toolCallId);
                    this.pendingTools.add(event.data.toolCallId);
                    this.push({
                        type: "block-end",
                        index: this.block(`tool:${event.data.toolCallId}`).index,
                        block: {
                            type: "tool-call",
                            id: ToolCallId(event.data.toolCallId),
                            name: event.data.toolName,
                            arguments: JSON.stringify(event.data.arguments ?? {}),
                        },
                    });
                    this.commit(false);
                }
                this.tools.add(event.data.toolCallId);
                this.pendingTools.add(event.data.toolCallId);
                this.session.append("tool/call", {
                    turn: this.turn,
                    step: this.step,
                    callId: ToolCallId(event.data.toolCallId),
                    name: event.data.toolName,
                    arguments: JSON.stringify(event.data.arguments ?? {}),
                });
                break;
            case "tool.execution_complete":
                if (!this.tools.delete(event.data.toolCallId))
                    break;
                this.pendingTools.delete(event.data.toolCallId);
                this.openStep();
                this.session.append("tool/result", {
                    turn: this.turn,
                    step: this.step,
                    message: createToolResultMessage({
                        callId: ToolCallId(event.data.toolCallId),
                        content: [
                            {
                                type: "text",
                                text: event.data.result?.content ??
                                    event.data.error?.message ??
                                    "",
                            },
                        ],
                        isError: !event.data.success,
                    }),
                }, { surfaceOp: "append" });
                break;
            case "session.error":
                this.error = new Error(event.data.message);
                break;
        }
    }
    finish(interrupted) {
        for (const stream of this.childStreams.values()) {
            if (stream.pending) {
                this.progress(stream.label + stream.pending);
                stream.pending = "";
            }
        }
        this.commit(interrupted);
        if (this.pendingTools.size) {
            const recovery = new ToolCallRecovery();
            for (const event of this.session.snapshotEvents(this.startOffset))
                recovery.observe(event);
            for (const event of recovery.results())
                this.session.append("tool/result", event.data, {
                    surfaceOp: "append",
                    ...(event.sourceEventSeqs
                        ? { sourceEventSeqs: event.sourceEventSeqs }
                        : {}),
                });
        }
        this.tools.clear();
        this.pendingTools.clear();
        this.closeStep();
    }
    commit(interrupted) {
        const attempt = this.attempt;
        if (!attempt)
            return;
        this.push({ type: "finish", reason: { kind: "stop" } });
        const event = this.session.append("assistant/message", {
            turn: this.turn,
            step: this.step,
            message: attempt.assembler.message({
                provider: PROVIDER,
                model: this.model,
            }),
            stream: [...attempt.stream.snapshot()],
            ...(interrupted ? { interrupted: true } : {}),
        }, { surfaceOp: "append" });
        this.events.emit("agent/assistant-stream", {
            frame: {
                type: "end",
                attemptId: attempt.id,
                revision: this.revision,
                index: attempt.index,
                outcome: {
                    kind: "committed",
                    eventType: "assistant/message",
                    seq: event.seq,
                },
            },
        });
        this.attempt = undefined;
        // Tool results and trailing runtime notices still belong to this step.
        this.settled = true;
    }
}
