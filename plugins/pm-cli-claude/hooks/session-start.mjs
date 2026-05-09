#!/usr/bin/env node
/**
 * pm-cli Claude Code session-start hook.
 *
 * Injects a brief pm context summary into the session when pm is initialized
 * in the current workspace. Exits silently if pm is not set up.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const workspace = process.cwd();
const pmSettingsPath = join(workspace, ".agents", "pm", "settings.json");

if (!existsSync(pmSettingsPath)) {
  process.exit(0);
}

try {
  const raw = execSync("pm context --limit 5 --json", {
    cwd: workspace,
    encoding: "utf-8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
  });

  const ctx = JSON.parse(raw);
  const { summary } = ctx;
  if (!summary) {
    process.exit(0);
  }

  const parts = [];
  if (summary.in_progress > 0) parts.push(`${summary.in_progress} in_progress`);
  if (summary.open > 0) parts.push(`${summary.open} open`);
  if (summary.blocked > 0) parts.push(`${summary.blocked} BLOCKED`);

  if (parts.length === 0) {
    process.exit(0);
  }

  const topItems = [...(ctx.high_level ?? []), ...(ctx.low_level ?? [])].slice(0, 3);
  const itemLines = topItems
    .map((item) => `  • [${item.id}] ${item.title} (${item.status})`)
    .join("\n");

  process.stdout.write(
    `pm tracker: ${parts.join(", ")}\n` +
      (itemLines ? `${itemLines}\n` : "") +
      `Use pm_context tool or /pm-status for full details.\n`,
  );
} catch {
  // pm unavailable, not initialized, or timed out — exit silently
  process.exit(0);
}
