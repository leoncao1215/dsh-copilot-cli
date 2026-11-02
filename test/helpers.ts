import { Context } from "@deepseek-ai/cordis";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import { turnBoundaryProjectionDefinition } from "@deepseek-ai/dsh-agent-loop";
import { SessionStore } from "@deepseek-ai/dsh-session";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import * as persistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import { ApprovalService } from "@deepseek-ai/dsh-user-approval";
import { CopilotDriver, type Config } from "../src/index.js";
import { inboxProjection } from "../src/inbox.js";
import type { Runtime } from "../src/runtime.js";

export async function harness(
  root: string,
  runtime: Runtime,
  config: Partial<Config> = {},
) {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(ApprovalService);
  await ctx.plugin(persistence, { root, compression: "none" });
  let driver!: CopilotDriver;
  await ctx.plugin({
    name: "test-copilot-driver",
    inject: [
      "agents",
      "sessions",
      "sessionProjections",
      "sessionPersistence",
      "approval",
    ],
    apply(owner: Context) {
      owner.sessionProjections.register(inboxProjection);
      owner.sessionProjections.register(turnBoundaryProjectionDefinition);
      driver = new CopilotDriver(
        owner,
        {
          cliPath: "copilot",
          model: "auto",
          permission: "ask",
          turnTimeoutMs: 5000,
          ...config,
        },
        runtime,
      );
      owner.agents.setFactory(driver);
    },
  });
  return {
    ctx,
    driver,
    async dispose() {
      await driver.dispose();
      await ctx.fiber.dispose();
    },
  };
}
