import type { AgentEventDispatch, Inbox, InboxState, InboxTarget, InboxWireState } from "@deepseek-ai/dsh-agent";
import type { MessageId, UserMessage } from "@deepseek-ai/dsh-llm";
import type { Session } from "@deepseek-ai/dsh-session";
import { z } from "zod";
export declare const inboxProjection: {
    key: "inbox";
    stateVersion: number;
    stateSchema: z.ZodObject<{
        "next-turn": z.ZodReadonly<z.ZodArray<z.ZodCustom<UserMessage, UserMessage>>>;
        "next-step": z.ZodReadonly<z.ZodArray<z.ZodCustom<UserMessage, UserMessage>>>;
    }, z.core.$strip>;
    init: () => {
        "next-turn": never[];
        "next-step": never[];
    };
    apply(state: NoInfer<InboxState>, event: import("@deepseek-ai/dsh-session").SessionEvent): InboxState;
    wire: {
        viewSchema: z.ZodType<InboxWireState>;
        view: (state: InboxState) => InboxWireState;
    };
};
export declare class CopilotInbox implements Inbox {
    private readonly session;
    private readonly state;
    private readonly events;
    constructor(session: Session, state: () => InboxState, events: AgentEventDispatch);
    get nextTurn(): readonly UserMessage[];
    get nextStep(): readonly UserMessage[];
    get hasPending(): boolean;
    append(target: InboxTarget, message: UserMessage): void;
    prepend(target: InboxTarget, message: UserMessage): void;
    replace(id: MessageId, message: UserMessage): boolean;
    remove(id: MessageId): boolean;
    private edit;
    clear(): void;
    claim(turn: number): UserMessage[];
    splice(target: InboxTarget, start: number, deleteCount: number, inserted: UserMessage[]): UserMessage[];
    private change;
}
