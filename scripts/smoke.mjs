import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { copilotSessionId, resolveCliPath } from "../dist/runtime.js";
import { root, writePatch } from "./profile.mjs";

const require = createRequire(import.meta.url);
const bin = join(
  dirname(require.resolve("@deepseek-ai/dsh/package.json")),
  "lib",
  "bin.js",
);
await mkdir(join(root, ".smoke"), { recursive: true });
const home = await mkdtemp(join(root, ".smoke", "web-"));
const workspace = join(home, "workspace");
await mkdir(workspace);
const marker = `DSH_COPILOT_${randomUUID().replaceAll("-", "")}`;
await writeFile(join(workspace, "marker.txt"), marker);
const patch = await writePatch(home);
const overlay = JSON.parse(await readFile(patch, "utf8"));
overlay.push({
  insert: [
    {
      id: "smoke-file-approval",
      name: join(root, "scripts", "smoke-approval.mjs"),
      config: { path: join(workspace, "marker.txt") },
    },
  ],
});
await writeFile(patch, JSON.stringify(overlay));
let server;
let sessionId;

async function start() {
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const child = spawn(
    process.execPath,
    [bin, "web", "--patch", patch, "--no-open", "--port", String(port)],
    {
      cwd: root,
      env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server = child;
  let diagnostics = "";
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Web startup timed out: ${diagnostics}`)),
      60_000,
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Web exited (${code}): ${diagnostics}`));
    });
    child.stderr.on("data", (chunk) => {
      diagnostics += chunk;
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(
        /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/,
      );
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });
  const login = await fetch(url, { redirect: "manual" });
  const cookie = login.headers
    .getSetCookie()
    .map((entry) => entry.split(";")[0])
    .join("; ");
  assert.ok(cookie, "Web authentication did not issue a cookie");
  const base = `http://127.0.0.1:${port}`;
  const page = await fetch(base, { headers: { cookie } });
  assert.equal(page.status, 200);
  return async (method, payload) => {
    const response = await fetch(`${base}/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        type: "client-request",
        rpcId: randomUUID(),
        method,
        payload: { args: payload },
      }),
    });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    const envelope = JSON.parse(body);
    if (!envelope.result?.ok)
      throw new Error(JSON.stringify(envelope.result?.error ?? envelope));
    return envelope.result.value;
  };
}

async function stop() {
  if (!server || server.exitCode !== null) return;
  const child = server;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  if (process.platform === "win32") {
    const kill = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
    await new Promise((resolve) => kill.once("exit", resolve));
  } else {
    child.kill("SIGTERM");
  }
  await exited;
  server = undefined;
}

async function send(rpc, text) {
  await rpc("session/prompt", {
    request: {
      sessionId,
      requestId: randomUUID(),
      mode: "queue",
      content: [{ type: "text", text }],
    },
  });
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const list = await rpc("session/list", { _request: {} });
    if (
      list.items.find((item) => item.sessionId === sessionId)?.running === false
    ) {
      const projection = await rpc("session/projections", {
        request: { sessionId },
      });
      const page = await rpc("session/page", {
        request: {
          address: { kind: "session", sessionId },
          throughSeq: projection.asOfSeq,
          maxMessages: 100,
        },
      });
      const events = page.records
        .filter((record) => record.type === "event")
        .map((record) => record.event);
      const end = events.findLast((event) => event.type === "turn/end");
      assert.equal(end?.data.reason.kind, "completed", JSON.stringify(end));
      const message = events.findLast(
        (event) => event.type === "assistant/message",
      );
      return {
        events,
        text: message?.data.message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join(""),
      };
    }
    await delay(500);
  }
  throw new Error("Copilot prompt did not finish in three minutes");
}

try {
  let rpc = await start();
  const created = await rpc("session/create", { request: { cwd: workspace } });
  sessionId = created.sessionId;
  console.log("Web session created with the replacement driver.");
  const first = await send(
    rpc,
    `Remember this code for this conversation: ${marker}. Reply with only that code. Do not use any tools.`,
  );
  assert.ok(first.text.includes(marker), first.text);
  console.log("Real Copilot prompt completed through the Web API.");
  await delay(1500);
  await stop();
  rpc = await start();
  const resumed = await send(
    rpc,
    "What code did I ask you to remember? Reply with only that code. Do not use any tools.",
  );
  assert.ok(resumed.text.includes(marker), resumed.text);
  console.log("Context survived a complete dsh/Copilot process restart.");
  const tool = await send(
    rpc,
    "Use your file-reading tool to read marker.txt in the working directory. Reply with only its contents.",
  );
  assert.ok(tool.text.includes(marker), tool.text);
  assert.ok(
    tool.events.some((event) => event.type === "tool/call"),
    "No real tool call was projected",
  );
  assert.ok(
    tool.events.some((event) => event.type === "tool/result"),
    "No real tool result was projected",
  );
  console.log("Real Copilot tool execution was projected into dsh history.");
} finally {
  await stop();
  if (sessionId) {
    const client = new CopilotClient({
      connection: RuntimeConnection.forStdio({
        path: resolveCliPath(process.env.DSH_COPILOT_CLI || "copilot"),
      }),
    });
    try {
      await client.start();
      await client.deleteSession(copilotSessionId(sessionId));
    } finally {
      await client.stop();
    }
  }
  await rm(home, { recursive: true, force: true });
}
