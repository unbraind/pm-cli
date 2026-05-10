#!/usr/bin/env node
/**
 * pm-cli Claude Code session-start hook.
 *
 * Injects a brief pm context summary into the session when pm is initialized
 * in the current workspace. Uses native pm modules when available (repo checkout
 * or dist/); falls back to npx @unbrained/pm-cli without requiring the CLI to
 * be installed globally. Exits silently if pm is not set up.
 */
import { access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execSync } from "node:child_process";

const workspace = process.cwd();
const pmSettingsPath = join(workspace, ".agents", "pm", "settings.json");

if (!existsSync(pmSettingsPath)) {
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function findNativeModule() {
  let cursor = here;
  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = join(cursor, "dist", "pi", "native.js");
    if (await pathExists(candidate)) {
      return candidate;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
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

async function tryNativeContext() {
  const nativePath = await findNativeModule();
  if (!nativePath) return null;

  try {
    const { runNativePmAction } = await import(pathToFileURL(nativePath).href);
    const result = await runNativePmAction({
      action: "context",
      cwd: workspace,
      json: true,
      options: { limit: "5" },
    });
    const text = Array.isArray(result?.content)
      ? result.content.find((p) => p?.type === "text")?.text ?? ""
      : typeof result === "string"
        ? result
        : JSON.stringify(result);
    return JSON.parse(text);
  } catch {
    return null;
  }
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
  const ctx = (await tryNativeContext()) ?? tryNpxContext();
  if (!ctx) process.exit(0);

  const message = formatSummary(ctx);
  if (message) process.stdout.write(message);
} catch {
  // Any failure: exit silently
  process.exit(0);
}
