export const name = "copilot-smoke-file-approval";

export function apply(ctx, config) {
  ctx.on("approval/request", (request, next) => {
    const permission = JSON.parse(request.reason || "{}");
    return permission.kind === "read" && permission.path === config.path
      ? "allowed-once"
      : next();
  });
}
