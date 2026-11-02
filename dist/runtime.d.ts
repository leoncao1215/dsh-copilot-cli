import { CopilotClient, type CopilotSession, type SessionConfig, type ResumeSessionConfig } from "@github/copilot-sdk";
export type RuntimeSession = Pick<CopilotSession, "on" | "sendAndWait" | "abort" | "disconnect" | "setModel"> & {
    rpc: {
        metadata: Pick<CopilotSession["rpc"]["metadata"], "setWorkingDirectory">;
    };
};
export interface Runtime {
    start(): Promise<void>;
    createSession(config: SessionConfig): Promise<RuntimeSession>;
    resumeSession(id: string, config: ResumeSessionConfig): Promise<RuntimeSession>;
    listModels(): ReturnType<CopilotClient["listModels"]>;
    stop(): Promise<unknown>;
}
export declare const PROVIDER = "copilot-cli";
export declare function copilotSessionId(id: string): string;
export declare function createRuntime(cliPath: string): Runtime;
export declare function resolveCliPath(command: string): string;
