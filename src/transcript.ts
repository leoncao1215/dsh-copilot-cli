import { randomUUID } from "node:crypto";
import type { AgentEventDispatch } from "@deepseek-ai/dsh-agent";
import {
  AssistantStreamAccumulator,
  BlockAssembler,
  LlmAttemptId,
  ToolCallId,
  createToolResultMessage,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import type { Session } from "@deepseek-ai/dsh-session";
import type { SessionEvent } from "@github/copilot-sdk";
import { PROVIDER } from "./runtime.js";

class Attempt {
  readonly id = LlmAttemptId(randomUUID());
  readonly stream = new AssistantStreamAccumulator();
  readonly assembler = new BlockAssembler();
  index = 0;
  text = "";
  reasoning = "";
}

export class Transcript {
  private attempt?: Attempt;
  private revision = 0;
  private readonly tools = new Set<string>();
  error?: Error;

  constructor(
    private readonly session: Session,
    private readonly events: AgentEventDispatch,
    private readonly turn: number,
    private readonly model: string,
  ) {}

  private push(chunk: StreamChunk) {
    if (!this.attempt) {
      this.attempt = new Attempt();
      this.events.emit("agent/assistant-stream", {
        frame: {
          type: "start",
          attemptId: this.attempt.id,
          revision: (this.revision = this.session.seq + 1),
          turn: this.turn,
          step: 1,
        },
      });
    }
    const { attempt } = this;
    if (chunk.type === "text-delta") attempt.text += chunk.text;
    if (chunk.type === "reasoning-delta") attempt.reasoning += chunk.text;
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

  accept(event: SessionEvent) {
    if ("parentToolCallId" in event.data && event.data.parentToolCallId) return;
    switch (event.type) {
      case "assistant.message_delta":
        this.push({
          type: "text-delta",
          index: 1,
          text: event.data.deltaContent,
        });
        break;
      case "assistant.reasoning_delta":
        this.push({
          type: "reasoning-delta",
          index: 0,
          text: event.data.deltaContent,
        });
        break;
      case "assistant.message": {
        const { data } = event;
        if (data.reasoningText) {
          const previous = this.attempt?.reasoning ?? "";
          if (
            data.reasoningText.startsWith(previous) &&
            data.reasoningText.length > previous.length
          ) {
            this.push({
              type: "reasoning-delta",
              index: 0,
              text: data.reasoningText.slice(previous.length),
            });
          }
          this.push({
            type: "block-end",
            index: 0,
            block: { type: "reasoning", text: data.reasoningText },
          });
        }
        const previous = this.attempt?.text ?? "";
        if (
          data.content.startsWith(previous) &&
          data.content.length > previous.length
        ) {
          this.push({
            type: "text-delta",
            index: 1,
            text: data.content.slice(previous.length),
          });
        }
        this.push({
          type: "block-end",
          index: 1,
          block: { type: "text", text: data.content },
        });
        for (const [index, tool] of (data.toolRequests ?? []).entries()) {
          this.push({
            type: "block-end",
            index: index + 2,
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
        if (this.tools.has(event.data.toolCallId)) break;
        this.tools.add(event.data.toolCallId);
        this.session.append("tool/call", {
          turn: this.turn,
          step: 1,
          callId: ToolCallId(event.data.toolCallId),
          name: event.data.toolName,
          arguments: JSON.stringify(event.data.arguments ?? {}),
        });
        break;
      case "tool.execution_complete":
        if (!this.tools.delete(event.data.toolCallId)) break;
        this.session.append(
          "tool/result",
          {
            turn: this.turn,
            step: 1,
            message: createToolResultMessage({
              callId: ToolCallId(event.data.toolCallId),
              content: [
                {
                  type: "text",
                  text:
                    event.data.result?.content ??
                    event.data.error?.message ??
                    "",
                },
              ],
              isError: !event.data.success,
            }),
          },
          { surfaceOp: "append" },
        );
        break;
      case "session.error":
        this.error = new Error(event.data.message);
        break;
    }
  }

  finish(interrupted: boolean) {
    this.commit(interrupted);
    for (const id of this.tools) {
      this.session.append(
        "tool/result",
        {
          turn: this.turn,
          step: 1,
          message: createToolResultMessage({
            callId: ToolCallId(id),
            content: [
              {
                type: "text",
                text: "Copilot execution ended before this tool reported a result.",
              },
            ],
            isError: true,
          }),
        },
        { surfaceOp: "append" },
      );
    }
    this.tools.clear();
  }

  private commit(interrupted: boolean) {
    const attempt = this.attempt;
    if (!attempt) return;
    this.push({ type: "finish", reason: { kind: "stop" } });
    const event = this.session.append(
      "assistant/message",
      {
        turn: this.turn,
        step: 1,
        message: attempt.assembler.message({
          provider: PROVIDER,
          model: this.model,
        }),
        stream: [...attempt.stream.snapshot()],
        ...(interrupted ? { interrupted: true as const } : {}),
      },
      { surfaceOp: "append" },
    );
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
  }
}
