import type {
  AgentEventDispatch,
  Inbox,
  InboxState,
  InboxTarget,
  InboxWireState,
} from "@deepseek-ai/dsh-agent";
import type { MessageId, UserMessage } from "@deepseek-ai/dsh-llm";
import type { Session } from "@deepseek-ai/dsh-session";
import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";
import { z } from "zod";

const schema = z.object({
  "next-turn": z.array(z.custom<UserMessage>()).readonly(),
  "next-step": z.array(z.custom<UserMessage>()).readonly(),
});

export const inboxProjection = {
  key: "inbox",
  stateVersion: 1,
  stateSchema: schema,
  init: () => ({ "next-turn": [], "next-step": [] }),
  apply(state, event) {
    if (event.type !== "agent/inbox/spliced") return state;
    const { target, start, removedCount = 0, inserted } = event.data;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(removedCount) ||
      start < 0 ||
      removedCount < 0 ||
      start + removedCount > state[target].length
    ) {
      throw new Error(`Invalid persisted inbox splice at ${event.seq}`);
    }
    const next = {
      ...state,
      [target]: state[target].toSpliced(start, removedCount, ...inserted),
    };
    const messages = [...next["next-turn"], ...next["next-step"]];
    if (
      new Set(messages.map((message) => message.id)).size !== messages.length
    ) {
      throw new Error("Duplicate pending message identity");
    }
    return next;
  },
  wire: {
    viewSchema: schema as unknown as z.ZodType<InboxWireState>,
    view: (state: InboxState) => state as unknown as InboxWireState,
  },
} satisfies ProjectionDefinition<"inbox", InboxState>;

export class CopilotInbox implements Inbox {
  constructor(
    private readonly session: Session,
    private readonly state: () => InboxState,
    private readonly events: AgentEventDispatch,
  ) {}

  get nextTurn() {
    return this.state()["next-turn"];
  }

  get nextStep() {
    return this.state()["next-step"];
  }

  get hasPending() {
    return this.nextTurn.length + this.nextStep.length > 0;
  }

  append(target: InboxTarget, message: UserMessage) {
    this.splice(target, this.state()[target].length, 0, [message]);
  }

  prepend(target: InboxTarget, message: UserMessage) {
    this.splice(target, 0, 0, [message]);
  }

  replace(id: MessageId, message: UserMessage): boolean {
    return this.edit(id, [message]);
  }

  remove(id: MessageId): boolean {
    return this.edit(id, []);
  }

  private edit(id: MessageId, inserted: UserMessage[]): boolean {
    for (const target of ["next-step", "next-turn"] as const) {
      const index = this.state()[target].findIndex(
        (message) => message.id === id,
      );
      if (index < 0) continue;
      this.splice(target, index, 1, inserted);
      return true;
    }
    return false;
  }

  clear() {
    this.splice("next-step", 0, this.nextStep.length, []);
    this.splice("next-turn", 0, this.nextTurn.length, []);
  }

  claim(turn: number): UserMessage[] {
    const messages = [
      ...this.change("next-step", 0, this.nextStep.length, [], false),
      ...this.change("next-turn", 0, 1, [], false),
    ];
    for (const message of messages) {
      this.events.emit("agent/inbox/claimed", { message, turn });
    }
    return messages;
  }

  splice(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
  ): UserMessage[] {
    return this.change(target, start, deleteCount, inserted, true);
  }

  private change(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
    discard: boolean,
  ): UserMessage[] {
    const current = this.state()[target];
    const candidate = [...current];
    const removed = candidate.splice(start, deleteCount, ...inserted);
    const first = Math.trunc(start) || 0;
    const offset =
      first < 0
        ? Math.max(current.length + first, 0)
        : Math.min(first, current.length);
    if (removed.length === 0 && inserted.length === 0) return [];
    const all = [
      ...candidate,
      ...this.state()[target === "next-turn" ? "next-step" : "next-turn"],
    ];
    if (new Set(all.map((message) => message.id)).size !== all.length) {
      throw new Error("Duplicate pending message identity");
    }
    const event = this.session.append("agent/inbox/spliced", {
      target,
      start: offset,
      removedCount: removed.length,
      inserted,
      ...(discard && removed.length > 0
        ? { outcome: "canceled" as const }
        : {}),
    });
    if (discard) {
      for (const message of removed) {
        this.events.emit("agent/inbox/discarded", { message });
      }
    }
    for (const message of event.data.inserted) {
      this.events.emit("agent/inbox/inserted", { message });
    }
    return removed;
  }
}
