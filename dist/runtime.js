import { createHash } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { CopilotClient, RuntimeConnection, } from "@github/copilot-sdk";
export const PROVIDER = "copilot-cli";
export function copilotSessionId(id) {
    const bytes = createHash("sha256").update(`dsh-agent-copilot:${id}`).digest();
    bytes[6] = (bytes[6] & 15) | 80;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = bytes.subarray(0, 16).toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function createRuntime(cliPath) {
    return new CopilotClient({
        connection: RuntimeConnection.forStdio({ path: resolveCliPath(cliPath) }),
        mode: "copilot-cli",
    });
}
export function resolveCliPath(command) {
    const candidates = isAbsolute(command) || command.includes("\\") || command.includes("/")
        ? [resolve(command)]
        : (process.env.PATH ?? "")
            .split(delimiter)
            .flatMap((directory) => (process.platform === "win32" ? [".exe", "", ".cmd"] : [""]).map((suffix) => join(directory, command + suffix)));
    for (const candidate of candidates) {
        try {
            accessSync(candidate, constants.X_OK);
            return candidate;
        }
        catch { }
    }
    throw new Error(`Copilot CLI executable not found: ${command}`);
}
