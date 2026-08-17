#!/usr/bin/env node
// Measures the agent-facing token surface of the pm CLI (baseline chore pm-a22j):
// root help, every per-command help, the contracts payload family, and the MCP
// tools/list payload. Emits a JSON report on stdout so jq can slice it, e.g.:
//   node scripts/measure-agent-token-surface.mjs | jq '.per_command_total'
//   ... | jq '[.commands[] | select(.name | startswith("list"))] | map(.bytes) | add'
// Re-run after each consolidation slice lands and diff against the recorded baseline.

import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PM_CORE_COMMAND_NAMES } from "../dist/sdk/cli-contracts.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIGURED_PM_BIN = process.env.PM_BIN;
const PM_BIN = CONFIGURED_PM_BIN ?? process.execPath;
const PM_PREFIX_ARGS = CONFIGURED_PM_BIN
  ? []
  : [join(REPO_ROOT, "dist", "cli.js")];
const MCP_SERVER = join(REPO_ROOT, "dist", "mcp", "server.js");
const DEFAULT_BASELINE = join(
  REPO_ROOT,
  "scripts",
  "agent-token-surface-baseline.json",
);
const CORE_COMMAND_NAMES = new Set(PM_CORE_COMMAND_NAMES);

function tokens(bytes) {
  return Math.ceil(bytes / 4);
}

/** Build a versioned regression baseline with explicit percentage headroom. */
export function buildBaseline(report, headroom = 1.1) {
  const budget = (measurement) => Math.ceil(measurement.bytes * headroom);
  return {
    version: 2,
    metric: "utf8_bytes",
    headroom,
    surfaces: {
      root_help: budget(report.root_help),
      per_command_total: budget(report.per_command_total),
      full_help_surface: budget(report.full_help_surface),
      contracts: Object.fromEntries(
        Object.entries(report.contracts).map(([name, measurement]) => [
          name,
          budget(measurement),
        ]),
      ),
      mcp_tools_list: budget(report.mcp_tools_list),
      required_commands: report.commands
        .map((entry) => entry.name)
        .filter((name) => CORE_COMMAND_NAMES.has(name))
        .sort((left, right) => left.localeCompare(right)),
      commands: Object.fromEntries(
        report.commands.map((entry) => [entry.name, budget(entry)]),
      ),
    },
  };
}

/** Compare a measured report with a committed token-surface baseline. */
export function compareBaseline(report, baseline) {
  const violations = [];
  const surfaces = baseline.surfaces ?? {};
  const compare = (name, bytes, maxBytes) => {
    if (!Number.isFinite(maxBytes)) {
      violations.push(`${name}: missing baseline`);
    } else if (bytes > maxBytes) {
      violations.push(`${name}: ${bytes} bytes exceeds ${maxBytes}`);
    }
  };
  compare("root_help", report.root_help.bytes, surfaces.root_help);
  compare(
    "per_command_total",
    report.per_command_total.bytes,
    surfaces.per_command_total,
  );
  compare(
    "full_help_surface",
    report.full_help_surface.bytes,
    surfaces.full_help_surface,
  );
  compare(
    "mcp_tools_list",
    report.mcp_tools_list.bytes,
    surfaces.mcp_tools_list,
  );
  for (const [name, measurement] of Object.entries(report.contracts)) {
    compare(`contracts.${name}`, measurement.bytes, surfaces.contracts?.[name]);
  }
  violations.push(
    ...Object.keys(surfaces.contracts ?? {})
      .filter((name) => !Object.hasOwn(report.contracts, name))
      .map((name) => `contracts.${name}: stale baseline surface`),
  );
  const reportCommandNames = new Set(
    report.commands.map((measurement) => measurement.name),
  );
  const requiredCommandNames = new Set(surfaces.required_commands ?? []);
  for (const measurement of report.commands) {
    if (
      !CORE_COMMAND_NAMES.has(measurement.name) &&
      !requiredCommandNames.has(measurement.name) &&
      !Object.hasOwn(surfaces.commands ?? {}, measurement.name)
    ) {
      continue;
    }
    compare(
      `commands.${measurement.name}`,
      measurement.bytes,
      surfaces.commands?.[measurement.name],
    );
  }
  violations.push(
    ...[...requiredCommandNames]
      .filter((name) => !reportCommandNames.has(name))
      .map((name) => `commands.${name}: stale baseline surface`),
  );
  return violations;
}

function measure(args) {
  try {
    const out = execFileSync(
      PM_BIN,
      [...PM_PREFIX_ARGS, ...args, "--no-pager"],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return Buffer.byteLength(out);
  } catch (error) {
    const out = typeof error.stdout === "string" ? error.stdout : "";
    if (out.length > 0) return Buffer.byteLength(out);
    throw new Error(`pm ${args.join(" ")} failed: ${error.message}`, {
      cause: error,
    });
  }
}

function listCommands() {
  const help = execFileSync(
    PM_BIN,
    [...PM_PREFIX_ARGS, "--help", "--no-pager"],
    {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const lines = help.split("\n");
  const start = lines.findIndex((line) => line.trim() === "Commands:");
  const names = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") break;
    const match = /^ {2}(\S+)/.exec(line);
    if (!match) continue;
    const name = match[1].split("|")[0];
    if (name !== "help") names.push(name);
  }
  return { rootHelpBytes: Buffer.byteLength(help), names };
}

function measureMcpToolsList() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MCP_SERVER], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let buffer = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("MCP tools/list timed out after 30s"));
    }, 30_000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (const line of buffer.split("\n")) {
        if (!line.trim()) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (parsed.id !== 1) continue;
        clearTimeout(timer);
        child.kill();
        resolve({
          bytes: Buffer.byteLength(line),
          tokens: tokens(Buffer.byteLength(line)),
          tool_count: parsed.result?.tools?.length ?? 0,
        });
        return;
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`,
    );
  });
}

const pmVersion = execFileSync(PM_BIN, [...PM_PREFIX_ARGS, "--version"], {
  encoding: "utf8",
}).trim();
const { rootHelpBytes, names } = listCommands();

const commands = names
  .map((name) => {
    const bytes = measure([name, "--help"]);
    return { name, bytes, tokens: tokens(bytes) };
  })
  .sort((a, b) => b.bytes - a.bytes);
const perCommandBytes = commands.reduce((sum, entry) => sum + entry.bytes, 0);

const contracts = {};
// Keep the opt-in complete payload and the explicit bounded refusal as
// separate ratchets: completeness must not masquerade as compactness, and the
// budgeted recovery envelope must not grow unnoticed.
for (const [key, args] of Object.entries({
  summary_toon: ["contracts", "--summary"],
  summary_json: ["contracts", "--summary", "--json"],
  json: ["contracts", "--json"],
  full: ["contracts", "--full"],
  bounded_full: ["--output-budget", "256", "contracts", "--full"],
})) {
  const bytes = measure(args);
  contracts[key] = { bytes, tokens: tokens(bytes) };
}

const report = {
  generated_at: new Date().toISOString(),
  pm_version: pmVersion,
  root_help: { bytes: rootHelpBytes, tokens: tokens(rootHelpBytes) },
  command_count: commands.length,
  per_command_total: {
    bytes: perCommandBytes,
    tokens: tokens(perCommandBytes),
  },
  full_help_surface: {
    bytes: rootHelpBytes + perCommandBytes,
    tokens: tokens(rootHelpBytes + perCommandBytes),
  },
  commands,
  contracts,
  mcp_tools_list: await measureMcpToolsList(),
};

const baselineFlagIndex = process.argv.indexOf("--baseline");
const baselinePath =
  baselineFlagIndex >= 0 && process.argv[baselineFlagIndex + 1]
    ? process.argv[baselineFlagIndex + 1]
    : DEFAULT_BASELINE;
if (process.argv.includes("--update")) {
  writeFileSync(
    baselinePath,
    `${JSON.stringify(buildBaseline(report), null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(
    `Updated agent token-surface baseline: ${baselinePath}\n`,
  );
} else if (process.argv.includes("--check")) {
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  if (baseline.version !== 2 || baseline.metric !== "utf8_bytes") {
    throw new Error(
      `Unsupported agent token-surface baseline: ${baselinePath}`,
    );
  }
  const violations = compareBaseline(report, baseline);
  if (violations.length > 0) {
    throw new Error(
      `Agent token-surface regression:\n${violations
        .map((violation) => `- ${violation}`)
        .join("\n")}`,
    );
  }
  process.stdout.write(
    `Agent token-surface gate passed (${report.command_count + Object.keys(report.contracts).length + 4} surfaces).\n`,
  );
} else {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
