import { Context } from "@deepseek-ai/cordis";
import type { AgentFactory, AgentHandle, CreateAgentOptions, ResumeAgentOptions } from "@deepseek-ai/dsh-agent";
import Schema from "@deepseek-ai/schemastery";
import { type Runtime } from "./runtime.js";
export { CopilotAgent } from "./agent.js";
export { copilotSessionId } from "./runtime.js";
export interface Config {
    cliPath: string;
    model: string;
    permission: "ask" | "deny";
    turnTimeoutMs: number;
}
export declare const name = "dsh-agent-copilot";
export declare const inject: string[];
export declare const Config: Schema<Config>;
export declare class CopilotDriver implements AgentFactory {
    private readonly ctx;
    private readonly config;
    private readonly runtime;
    private readonly handles;
    private readonly pending;
    private readonly teardown;
    constructor(ctx: Context, config: Config, runtime: Runtime);
    createAgent(owner: Context, options: CreateAgentOptions): Promise<AgentHandle>;
    resume(owner: Context, options: ResumeAgentOptions): Promise<AgentHandle>;
    private track;
    private initialize;
    private sessionConfig;
    dispose(): Promise<void>;
}
export declare function apply(ctx: Context, config: Config): Promise<void>;
