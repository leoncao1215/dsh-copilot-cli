import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { root, writePatch } from "./profile.mjs";

const require = createRequire(import.meta.url);
const home = resolve(process.env.DSH_HOME || join(root, ".dsh"));
const patchFile = await writePatch(home);
const bin = join(
  dirname(require.resolve("@deepseek-ai/dsh/package.json")),
  "lib",
  "bin.js",
);
const args = process.argv.slice(2);
const child = spawn(
  process.execPath,
  [bin, "web", "--patch", patchFile, ...args],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: "1" },
  },
);
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
