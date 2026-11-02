import { createHash } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import {
  CopilotClient,
  RuntimeConnection,
  type CopilotSession,
  type SessionConfig,
  type ResumeSessionConfig,
} from "@github/copilot-sdk";

export type RuntimeSession = Pick<
  CopilotSession,
  "on" | "sendAndWait" | "abort" | "disconnect" | "setModel"
> & {
  rpc: {
    metadata: Pick<CopilotSession["rpc"]["metadata"], "setWorkingDirectory">;
  };
};

export interface Runtime {
  start(): Promise<void>;
  createSession(config: SessionConfig): Promise<RuntimeSession>;
  resumeSession(
    id: string,
    config: ResumeSessionConfig,
  ): Promise<RuntimeSession>;
  listModels(): ReturnType<CopilotClient["listModels"]>;
  stop(): Promise<unknown>;
}

export const PROVIDER = "copilot-cli";

export function copilotSessionId(id: string): string {
  const bytes = createHash("sha256").update(`dsh-agent-copilot:${id}`).digest();
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createRuntime(cliPath: string): Runtime {
  return new CopilotClient({
    connection: RuntimeConnection.forStdio({ path: resolveCliPath(cliPath) }),
    mode: "copilot-cli",
  });
}

export function resolveCliPath(command: string): string {
  const candidates =
    isAbsolute(command) || command.includes("\\") || command.includes("/")
      ? [resolve(command)]
      : (process.env.PATH ?? "")
          .split(delimiter)
          .flatMap((directory) =>
            (process.platform === "win32" ? [".exe", "", ".cmd"] : [""]).map(
              (suffix) => join(directory, command + suffix),
            ),
          );
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error(`Copilot CLI executable not found: ${command}`);
}
