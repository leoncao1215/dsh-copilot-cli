import type { AgentEventDispatch } from "@deepseek-ai/dsh-agent";
import type { Session } from "@deepseek-ai/dsh-session";
import type { SessionEvent } from "@github/copilot-sdk";
export declare class Transcript {
    private readonly session;
    private readonly events;
    private readonly turn;
    private readonly model;
    private attempt?;
    private revision;
    private readonly tools;
    error?: Error;
    constructor(session: Session, events: AgentEventDispatch, turn: number, model: string);
    private push;
    accept(event: SessionEvent): void;
    finish(interrupted: boolean): void;
    private commit;
}
