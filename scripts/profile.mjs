import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = dirname(dirname(fileURLToPath(import.meta.url)));

export async function writePatch(home) {
  const model = process.env.DSH_COPILOT_MODEL || "auto";
  const patch = [
    { id: "agent-loop", disabled: true },
    { id: "session-title-llm", disabled: true },
    { id: "agent-default-model", config: { provider: "copilot-cli", model } },
    {
      insert: [
        {
          id: "copilot-agent-driver",
          name: join(root, "dist", "index.js"),
          config: {
            cliPath: process.env.DSH_COPILOT_CLI || "copilot",
            model,
            permission: "ask",
            turnTimeoutMs: 1_800_000,
          },
        },
      ],
    },
  ];
  await mkdir(home, { recursive: true });
  const path = join(home, "copilot.patch.json");
  await writeFile(path, `${JSON.stringify(patch, null, 2)}\n`);
  return path;
}
