import type { AgentEventDispatch } from "@deepseek-ai/dsh-agent";
import { type ContextFormed } from "@deepseek-ai/dsh-llm";
import { type Session } from "@deepseek-ai/dsh-session";
import type { SessionEvent } from "@github/copilot-sdk";
declare module "@deepseek-ai/dsh-llm" {
    interface MessageSourceMap {
        "copilot-progress": {
            kind: "copilot-progress";
        } & ContextFormed;
    }
}
export declare class Transcript {
    private readonly session;
    private readonly events;
    private readonly turn;
    private readonly model;
    private attempt?;
    private revision;
    private step;
    private stepOpen;
    private settled;
    private readonly tools;
    private readonly pendingTools;
    private readonly advertisedTools;
    private readonly childTools;
    private readonly subagents;
    private readonly notices;
    private readonly childStreams;
    private readonly childReasoning;
    private readonly startOffset;
    error?: Error;
    constructor(session: Session, events: AgentEventDispatch, turn: number, model: string);
    private openStep;
    private closeStep;
    private opening;
    private push;
    private block;
    private append;
    private complete;
    private notice;
    private progress;
    private reasoningFallback;
    private childContent;
    accept(event: SessionEvent): void;
    finish(interrupted: boolean): void;
    private commit;
}
