#!/usr/bin/env node

/**
 * Fail closed when live CLI contracts drift from the accepted noun–verb
 * destination census, alias targets, or visible-surface ceiling.
 *
 * Tracker: pm-wt43zj, pm-yy8rmx.
 */
import { execFileSync } from "node:child_process";
import {
  CREATE_FLAG_CONTRACTS,
  PM_COMMAND_ALIAS_CONTRACTS,
  PM_COMMAND_DESTINATION_CONTRACTS,
  PM_COMMAND_POSITIONAL_CONTRACTS,
  PM_DISCOVERABLE_TOOL_ACTIONS,
  TOOL_CREATE_OPTION_CONTRACTS,
  TOOL_UPDATE_OPTION_CONTRACTS,
  UPDATE_FLAG_CONTRACTS,
  verifyPmCliGrammar,
  verifyPmCommandPositionalContracts,
  verifyToolOptionCliParity,
} from "../../dist/sdk/index.js";
import { NARROW_TOOL_ACTIONS, TOOLS } from "../../dist/mcp/tool-definitions.js";
import { repoRoot } from "./utils.mjs";

const COMPOSITE_MCP_TOOL_WAIVERS = {
  pm_mutate:
    "Structured mutation dispatcher spanning multiple canonical mutation actions.",
};

/** Report duplicate names because MCP clients address tools by unique name. */
function findDuplicateMcpTools(toolNames) {
  const findings = [];
  for (const toolName of new Set(toolNames)) {
    if (toolNames.filter((candidate) => candidate === toolName).length > 1) {
      findings.push({
        code: "duplicate_mcp_tool",
        spelling: toolName,
        message: `MCP tool \`${toolName}\` is declared more than once.`,
      });
    }
  }
  return findings;
}

/** Compare the pm_run action enum with canonical discoverable SDK actions. */
function findPmRunActionDrift(discoverableActions, tools) {
  const pmRun = tools.find((tool) => tool.name === "pm_run");
  if (!pmRun) {
    return [
      {
        code: "missing_pm_run_tool",
        spelling: "pm_run",
        message: "The canonical MCP dispatcher tool is absent.",
      },
    ];
  }
  const pmRunActions = pmRun.inputSchema?.properties?.action?.enum;
  if (!Array.isArray(pmRunActions)) {
    return [
      {
        code: "invalid_pm_run_action_enum",
        spelling: "pm_run.action",
        message: "The pm_run action schema does not expose an enum.",
      },
    ];
  }
  const findings = [];
  const discoverableActionSet = new Set(discoverableActions);
  const pmRunActionSet = new Set(pmRunActions);
  for (const action of discoverableActions) {
    if (!pmRunActionSet.has(action)) {
      findings.push({
        code: "missing_pm_run_action",
        spelling: action,
        message: `Discoverable action \`${action}\` is absent from pm_run.`,
      });
    }
  }
  for (const action of pmRunActionSet) {
    if (!discoverableActionSet.has(action)) {
      findings.push({
        code: "stale_pm_run_action",
        spelling: String(action),
        message: `pm_run exposes undiscoverable action \`${String(action)}\`.`,
      });
    }
  }
  return findings;
}

/** Compare narrow and composite MCP tools with their canonical action bindings. */
function findNarrowMcpToolDrift(
  discoverableActionSet,
  toolNames,
  narrowToolActions,
) {
  const findings = [];
  const toolNameSet = new Set(toolNames);
  for (const [toolName, action] of Object.entries(narrowToolActions)) {
    if (!toolNameSet.has(toolName)) {
      findings.push({
        code: "missing_narrow_mcp_tool",
        spelling: toolName,
        message: `Narrow MCP action \`${action}\` has no tool \`${toolName}\`.`,
      });
    }
    if (!discoverableActionSet.has(action)) {
      findings.push({
        code: "undiscoverable_narrow_action",
        spelling: action,
        message: `Narrow MCP tool \`${toolName}\` targets undiscoverable action \`${action}\`.`,
      });
    }
  }
  for (const toolName of toolNames) {
    if (
      toolName.startsWith("pm_") &&
      toolName !== "pm_run" &&
      COMPOSITE_MCP_TOOL_WAIVERS[toolName] === undefined &&
      narrowToolActions[toolName] === undefined
    ) {
      findings.push({
        code: "unbound_narrow_mcp_tool",
        spelling: toolName,
        message: `Narrow MCP tool \`${toolName}\` has no canonical action binding.`,
      });
    }
  }
  for (const toolName of Object.keys(COMPOSITE_MCP_TOOL_WAIVERS)) {
    if (!toolNameSet.has(toolName)) {
      findings.push({
        code: "stale_composite_tool_waiver",
        spelling: toolName,
        message: `Composite MCP tool waiver \`${toolName}\` has no live tool.`,
      });
    }
  }
  return findings;
}

/** Verify discoverable SDK actions, pm_run enumeration, and narrow MCP tools. */
export function verifyMcpGrammar(
  discoverableActions,
  tools,
  narrowToolActions,
) {
  const discoverableActionSet = new Set(discoverableActions);
  const toolNames = tools.map((tool) => tool.name);
  const toolNameSet = new Set(toolNames);
  const findings = [
    ...findDuplicateMcpTools(toolNames),
    ...findPmRunActionDrift(discoverableActions, tools),
    ...findNarrowMcpToolDrift(
      discoverableActionSet,
      toolNames,
      narrowToolActions,
    ),
  ];
  return {
    ok: findings.length === 0,
    discoverable_action_count: discoverableActionSet.size,
    tool_count: toolNameSet.size,
    narrow_tool_count: Object.keys(narrowToolActions).length,
    composite_tool_waivers: Object.keys(COMPOSITE_MCP_TOOL_WAIVERS),
    findings,
  };
}

const raw = execFileSync(
  process.execPath,
  [
    "dist/cli.js",
    "contracts",
    "--full",
    "--json",
    "--output-budget",
    "unbounded",
  ],
  {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
    timeout: 120_000,
  },
);
const contracts = JSON.parse(raw);
const commands = Array.isArray(contracts.command_summaries)
  ? contracts.command_summaries
      .map((summary) => summary?.command)
      .filter((command) => typeof command === "string")
  : [];
const grammarReport = verifyPmCliGrammar(commands, PM_COMMAND_ALIAS_CONTRACTS);
const observedPositionalContracts = Array.isArray(
  contracts.grammar_contracts?.positional_signatures,
)
  ? contracts.grammar_contracts.positional_signatures
  : [];
const observedCommandSet = new Set(
  observedPositionalContracts.map(({ command }) => command),
);
const inactivePackageCommands = PM_COMMAND_DESTINATION_CONTRACTS.filter(
  ({ command, disposition }) =>
    disposition === "package_owned" && !observedCommandSet.has(command),
).map(({ command }) => command);
const inactivePackageCommandSet = new Set(inactivePackageCommands);
const positionalReport = verifyPmCommandPositionalContracts([
  ...observedPositionalContracts,
  ...PM_COMMAND_POSITIONAL_CONTRACTS.filter(({ command }) =>
    inactivePackageCommandSet.has(command),
  ),
]);
const mcpReport = verifyMcpGrammar(
  PM_DISCOVERABLE_TOOL_ACTIONS,
  TOOLS,
  NARROW_TOOL_ACTIONS,
);
const optionParity = {
  create: verifyToolOptionCliParity(
    TOOL_CREATE_OPTION_CONTRACTS,
    CREATE_FLAG_CONTRACTS,
  ),
  update: verifyToolOptionCliParity(
    TOOL_UPDATE_OPTION_CONTRACTS,
    UPDATE_FLAG_CONTRACTS,
  ),
};
const report = {
  ...grammarReport,
  ok:
    grammarReport.ok &&
    positionalReport.ok &&
    mcpReport.ok &&
    optionParity.create.ok &&
    optionParity.update.ok,
  mcp: { ...mcpReport, option_parity: optionParity },
  positionals: {
    ...positionalReport,
    inactive_package_commands: inactivePackageCommands,
  },
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ok) {
  process.exitCode = 1;
}
