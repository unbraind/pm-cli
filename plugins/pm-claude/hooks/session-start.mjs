#!/usr/bin/env node
/**
 * pm-cli Claude Code session-start hook.
 *
 * Injects a brief pm context summary into the session when pm is initialized
 * in the current workspace. Uses the published pm CLI through npx without
 * requiring a global install. Exits silently if pm is not set up.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const workspace = process.cwd();
const pmSettingsPath = join(workspace, ".agents", "pm", "settings.json");

if (!existsSync(pmSettingsPath)) {
  process.exit(0);
}

function formatSummary(ctx) {
  const { summary } = ctx;
  if (!summary) return null;

  const parts = [];
  if (summary.in_progress > 0) parts.push(`${summary.in_progress} in_progress`);
  if (summary.open > 0) parts.push(`${summary.open} open`);
  if (summary.blocked > 0) parts.push(`${summary.blocked} BLOCKED`);

  if (parts.length === 0) return null;

  const topItems = [...(ctx.high_level ?? []), ...(ctx.low_level ?? [])].slice(0, 3);
  const itemLines = topItems
    .map((item) => `  • [${item.id}] ${item.title} (${item.status})`)
    .join("\n");

  return (
    `pm tracker: ${parts.join(", ")}\n` +
    (itemLines ? `${itemLines}\n` : "") +
    `Use pm_context tool or /pm-status for full details.\n`
  );
}

function tryNpxContext() {
  try {
    const raw = execSync(
      "npx -y --package=@unbrained/pm-cli@latest pm context --limit 5 --json",
      {
        cwd: workspace,
        encoding: "utf-8",
        timeout: 15000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

try {
  const ctx = tryNpxContext();
  if (!ctx) process.exit(0);

  const message = formatSummary(ctx);
  if (message) process.stdout.write(message);
} catch {
  // Any failure: exit silently
  process.exit(0);
}
