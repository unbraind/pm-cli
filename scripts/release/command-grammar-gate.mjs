#!/usr/bin/env node

/**
 * Fail closed when live CLI contracts drift from the accepted noun–verb
 * destination census, alias targets, or visible-surface ceiling.
 *
 * Tracker: pm-wt43zj, pm-yy8rmx.
 */
import { execFileSync } from "node:child_process";
import { ASSURANCE_ACTIONS } from "../../dist/sdk/governance/assurance-action.js";
import { PLAN_SUBCOMMANDS } from "../../dist/sdk/lifecycle/plan.js";
import { WORKSPACE_SNAPSHOT_ACTIONS } from "../../dist/sdk/workspace-snapshot.js";
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

const RUNTIME_POSITIONAL_ACTIONS = new Map([
  ["assurance", ASSURANCE_ACTIONS],
  ["plan", PLAN_SUBCOMMANDS],
  ["workspace snapshot", WORKSPACE_SNAPSHOT_ACTIONS],
]);

/** Read structured help from the live Commander registration surface. */
function readLiveCliHelp(commandPath, noExtensions = false) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "dist/cli.js",
        ...(noExtensions ? ["--no-extensions"] : []),
        "--json",
        "help",
        ...commandPath,
        "--output-budget",
        "unbounded",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          NO_COLOR: "1",
          PM_NO_TELEMETRY: "1",
          PM_TELEMETRY_DISABLED: "1",
        },
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "inherit"],
        timeout: 120_000,
      },
    ),
  );
}

/** Normalize the visible structured-help child rows used by both traversals. */
function normalizeLiveHelpSubcommands(help) {
  if (!Array.isArray(help?.subcommands)) return [];
  return help.subcommands.flatMap((subcommand) => {
    if (
      Object(subcommand) !== subcommand ||
      typeof subcommand.name !== "string" ||
      subcommand.name.trim().length === 0
    ) {
      return [];
    }
    return [
      {
        name: subcommand.name.trim(),
        aliases: Array.isArray(subcommand.aliases)
          ? subcommand.aliases.flatMap((alias) =>
              typeof alias === "string" && alias.trim().length > 0
                ? [alias.trim()]
                : [],
            )
          : [],
      },
    ];
  });
}

/** Normalize positional slots emitted by the live structured-help adapter. */
function normalizeLiveHelpArguments(help) {
  if (!Array.isArray(help?.arguments)) return [];
  return help.arguments.flatMap((argument) =>
    Object(argument) === argument &&
    typeof argument.name === "string" &&
    argument.name.trim().length > 0 &&
    typeof argument.required === "boolean" &&
    typeof argument.variadic === "boolean"
      ? [
          {
            name: argument.name.trim(),
            required: argument.required,
            variadic: argument.variadic,
          },
        ]
      : [],
  );
}

/** Record one positional dispatcher family through its action-specific help views. */
function recordRuntimeActions(
  loadHelp,
  parentPath,
  parent,
  runtimeActions,
  registered,
  positionals,
) {
  for (const action of runtimeActions) {
    const command = `${parent} ${action}`;
    registered.add(command);
    positionals.set(
      command,
      normalizeLiveHelpArguments(loadHelp([...parentPath, action])),
    );
  }
}

/** Record visible child registrations, alias edges, and traversal work. */
function recordHelpSubcommands(
  help,
  parentPath,
  parent,
  registered,
  parents,
  aliases,
  queue,
) {
  for (const subcommand of normalizeLiveHelpSubcommands(help)) {
    const childPath = [...parentPath, subcommand.name];
    const child = childPath.join(" ");
    registered.add(child);
    parents.add(parent);
    const childAliases = aliases.get(child) ?? new Set();
    for (const alias of subcommand.aliases) {
      childAliases.add([...parentPath, alias].join(" "));
    }
    aliases.set(child, childAliases);
    if (!(parentPath.length === 0 && subcommand.name === "help")) {
      queue.push(childPath);
    }
  }
}

/** Walk canonical Commander paths and retain alias edges and namespace parents. */
function collectRegisteredCliCommands(loadHelp, registeredCommandSeeds = []) {
  const registered = new Set();
  const parents = new Set();
  const aliases = new Map();
  const positionals = new Map();
  const queue = [
    [],
    ...registeredCommandSeeds
      .filter((command) => command !== "help")
      .map((command) => command.split(" ")),
  ];
  const visited = new Set();
  while (queue.length > 0) {
    const parentPath = queue.shift();
    const parent = parentPath.join(" ");
    if (visited.has(parent)) continue;
    visited.add(parent);
    let help;
    try {
      help = loadHelp(parentPath);
    } catch {
      continue;
    }
    if (parent.length > 0) {
      registered.add(parent);
      positionals.set(parent, normalizeLiveHelpArguments(help));
    }
    const runtimeActions = RUNTIME_POSITIONAL_ACTIONS.get(parent);
    if (runtimeActions) {
      recordRuntimeActions(
        loadHelp,
        parentPath,
        parent,
        runtimeActions,
        registered,
        positionals,
      );
      continue;
    }
    recordHelpSubcommands(
      help,
      parentPath,
      parent,
      registered,
      parents,
      aliases,
      queue,
    );
  }
  return { registered, parents, aliases, positionals };
}

/** Expand equal-arity Commander aliases transitively across descendant paths. */
function expandRegisteredCommandAliases(registered, aliases, positionals) {
  for (const command of registered) {
    for (const [canonical, aliasPaths] of aliases) {
      if (command !== canonical && !command.startsWith(`${canonical} `)) {
        continue;
      }
      const canonicalArity = canonical.split(" ").length;
      const slots = positionals.get(command);
      for (const alias of [...aliasPaths].filter(
        (path) => path.split(" ").length === canonicalArity,
      )) {
        const aliasCommand = `${alias}${command.slice(canonical.length)}`;
        registered.add(aliasCommand);
        if (slots) positionals.set(aliasCommand, slots);
      }
    }
  }
}

/**
 * Traverse live Commander registrations without using the declared destination
 * or positional-contract catalogs. Positional dispatchers are added from the
 * runtime validators that actually accept their action tokens.
 */
export function collectLiveCliCommandPaths(
  loadHelp = readLiveCliHelp,
  activePackageCommands = [],
  registeredCommandSeeds = [],
) {
  return collectLiveCliCommandSurface(
    loadHelp,
    activePackageCommands,
    registeredCommandSeeds,
  ).commands;
}

/** Collect independently observed destinations and live positional structures. */
function collectLiveCliCommandSurface(
  loadHelp = readLiveCliHelp,
  activePackageCommands = [],
  registeredCommandSeeds = [],
) {
  const coreTopLevelCommands = new Set(
    registeredCommandSeeds.length > 0
      ? registeredCommandSeeds.filter((command) => !command.includes(" "))
      : normalizeLiveHelpSubcommands(loadHelp([], true)).map(({ name }) => name),
  );
  const { registered, parents, aliases, positionals } =
    collectRegisteredCliCommands(loadHelp, registeredCommandSeeds);
  expandRegisteredCommandAliases(registered, aliases, positionals);
  const helpFailures = [];
  for (const command of activePackageCommands) {
    if (!positionals.has(command)) {
      try {
        positionals.set(
          command,
          normalizeLiveHelpArguments(loadHelp(command.split(" "))),
        );
      } catch {
        helpFailures.push(command);
      }
    }
  }
  const observed = new Set(activePackageCommands);
  for (const command of registered) {
    if (
      coreTopLevelCommands.has(command.split(" ")[0]) ||
      !parents.has(command)
    ) {
      observed.add(command);
    }
  }
  const commands = [...observed].sort((left, right) =>
    left.localeCompare(right),
  );
  return {
    commands,
    helpFailures,
    positionals: commands.map((command) => {
      const declared = PM_COMMAND_POSITIONAL_CONTRACTS.find(
        (contract) => contract.command === command,
      );
      return {
        command,
        slots: (positionals.get(command) ?? []).map((slot, index) => ({
          ...slot,
          value_kind: declared?.slots[index]?.value_kind ?? "string",
          polymorphic: declared?.slots[index]?.polymorphic ?? false,
        })),
      };
    }),
  };
}

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
const packageOwnedCommandSet = new Set(
  PM_COMMAND_DESTINATION_CONTRACTS.filter(
    ({ disposition }) => disposition === "package_owned",
  ).map(({ command }) => command),
);
const hasCommandSummaries = Array.isArray(contracts.command_summaries);
const registeredCommandSeeds = hasCommandSummaries
  ? contracts.command_summaries.flatMap((summary) =>
      Object(summary) === summary && typeof summary.command === "string"
        ? [summary.command]
        : [],
    )
  : [];
const activePackageCommands = hasCommandSummaries
  ? contracts.command_summaries.flatMap((summary) =>
      Object(summary) === summary &&
      typeof summary.command === "string" &&
      packageOwnedCommandSet.has(summary.command)
        ? [summary.command]
        : [],
    )
  : [];
const liveCliSurface = collectLiveCliCommandSurface(
  readLiveCliHelp,
  activePackageCommands,
  registeredCommandSeeds,
);
const commands = liveCliSurface.commands;
const grammarReport = verifyPmCliGrammar(commands, PM_COMMAND_ALIAS_CONTRACTS);
if (!hasCommandSummaries) {
  grammarReport.ok = false;
  grammarReport.findings.push({
    code: "missing_destination",
    spelling: "contracts.command_summaries",
    message: "The live contracts response omitted its command summary census.",
    nearest_target: "pm contracts --full --json",
  });
}
for (const command of liveCliSurface.helpFailures) {
  grammarReport.ok = false;
  grammarReport.findings.push({
    code: "missing_destination",
    spelling: command,
    message: `Active package command \`${command}\` could not be read from live structured help.`,
    nearest_target: `pm ${command} --help --json`,
  });
}
const observedPositionalContracts = liveCliSurface.positionals;
const activeCommandSet = new Set(commands);
const observedSignatureCommandSet = new Set(
  observedPositionalContracts.map(({ command }) => command),
);
const inactivePackageCommands = PM_COMMAND_DESTINATION_CONTRACTS.filter(
  ({ command, disposition }) =>
    disposition === "package_owned" && !activeCommandSet.has(command),
).map(({ command }) => command);
const inactivePackageCommandSet = new Set(inactivePackageCommands);
const positionalReport = verifyPmCommandPositionalContracts([
  ...observedPositionalContracts,
  ...PM_COMMAND_POSITIONAL_CONTRACTS.filter(
    ({ command }) =>
      inactivePackageCommandSet.has(command) &&
      !observedSignatureCommandSet.has(command),
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
