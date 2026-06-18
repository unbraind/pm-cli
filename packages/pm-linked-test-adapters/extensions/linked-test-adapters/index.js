import {
  runTestRunsListPackage,
  runTestRunsLogsPackage,
  runTestRunsResumePackage,
  runTestRunsStatusPackage,
  runTestRunsStopPackage,
} from "./runtime.js";

export const manifest = {
  name: "builtin-linked-test-adapters",
  version: "0.1.0",
  entry: "./index.js",
  priority: 0,
  capabilities: ["commands", "schema"],
};

function assertNoArgs(args, commandName) {
  if (args.some((arg) => arg.trim().length > 0)) {
    throw new Error(`${commandName} does not accept positional arguments.`);
  }
}

function assertSingleRunId(args, commandName) {
  const runId = args[0];
  if (typeof runId !== "string" || runId.trim().length === 0) {
    throw new Error(`${commandName} requires a runId argument.`);
  }
  if (args.length > 1) {
    throw new Error(`${commandName} accepts exactly one runId argument.`);
  }
  return args;
}

function testRunsCommand() {
  return {
    name: "test-runs",
    action: "test-runs-list",
    description: "List background linked-test runs.",
    flags: [
      { long: "--status", value_name: "value", value_type: "string", description: "Filter by background run status." },
      { long: "--limit", value_name: "n", value_type: "string", description: "Limit number of runs returned." },
    ],
    run: async (context) => {
      assertNoArgs(context.args, "test-runs");
      return runTestRunsListPackage(context.options, context.global);
    },
  };
}

function testRunsListCommand() {
  return {
    name: "test-runs list",
    action: "test-runs-list",
    description: "List background linked-test runs.",
    flags: [
      { long: "--status", value_name: "value", value_type: "string", description: "Filter by background run status." },
      { long: "--limit", value_name: "n", value_type: "string", description: "Limit number of runs returned." },
    ],
    run: async (context) => {
      assertNoArgs(context.args, "test-runs list");
      return runTestRunsListPackage(context.options, context.global);
    },
  };
}

function testRunsStatusCommand() {
  return {
    name: "test-runs status",
    action: "test-runs-status",
    description: "Show status and health snapshot for a background linked-test run.",
    arguments: [{ name: "runId", required: true, description: "Background run id." }],
    run: async (context) => runTestRunsStatusPackage(assertSingleRunId(context.args, "test-runs status"), context.global),
  };
}

function testRunsLogsCommand() {
  return {
    name: "test-runs logs",
    action: "test-runs-logs",
    description: "Show tailed logs for a background linked-test run.",
    arguments: [{ name: "runId", required: true, description: "Background run id." }],
    flags: [
      { long: "--stream", value_name: "value", value_type: "string", description: "Log stream selector: stdout|stderr|both." },
      { long: "--tail", value_name: "n", value_type: "string", description: "Tail number of lines per selected stream." },
    ],
    run: async (context) => runTestRunsLogsPackage(assertSingleRunId(context.args, "test-runs logs"), context.options, context.global),
  };
}

function testRunsStopCommand() {
  return {
    name: "test-runs stop",
    action: "test-runs-stop",
    description: "Stop a running background linked-test run.",
    arguments: [{ name: "runId", required: true, description: "Background run id." }],
    flags: [{ long: "--force", value_type: "boolean", description: "Force-stop via SIGKILL." }],
    run: async (context) => runTestRunsStopPackage(assertSingleRunId(context.args, "test-runs stop"), context.options, context.global),
  };
}

function testRunsResumeCommand() {
  return {
    name: "test-runs resume",
    action: "test-runs-resume",
    description: "Resume a terminal background linked-test run by starting a new attempt.",
    arguments: [{ name: "runId", required: true, description: "Background run id." }],
    flags: [{ long: "--author", value_name: "value", value_type: "string", description: "Resume author override." }],
    run: async (context) => runTestRunsResumePackage(assertSingleRunId(context.args, "test-runs resume"), context.options, context.global),
  };
}

export function activate(api) {
  api.registerCommand(testRunsCommand());
  api.registerCommand(testRunsListCommand());
  api.registerCommand(testRunsStatusCommand());
  api.registerCommand(testRunsLogsCommand());
  api.registerCommand(testRunsStopCommand());
  api.registerCommand(testRunsResumeCommand());
}

export default {
  manifest,
  activate,
};
