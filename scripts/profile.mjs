import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = dirname(dirname(fileURLToPath(import.meta.url)));

export async function writePatch(home) {
  const model = process.env.DSH_COPILOT_MODEL || "auto";
  const patch = JSON.parse(
    await readFile(join(root, "copilot.patch.json"), "utf8"),
  );
  patch.find((row) => row.id === "agent-default-model").config.model = model;
  const driver = patch
    .flatMap((row) => row.insert ?? [])
    .find((row) => row.id === "copilot-agent-driver");
  driver.name = join(root, "dist", "index.js");
  driver.config.cliPath = process.env.DSH_COPILOT_CLI || "copilot";
  driver.config.model = model;
  await mkdir(home, { recursive: true });
  const path = join(home, "copilot.patch.json");
  await writeFile(path, `${JSON.stringify(patch, null, 2)}\n`);
  return path;
}
