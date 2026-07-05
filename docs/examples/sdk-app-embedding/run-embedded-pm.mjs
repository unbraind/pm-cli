import { spawnSync } from "node:child_process";
import { PM_TOOL_ACTION_PARAMETER_CONTRACTS, isPmToolAction } from "@unbrained/pm-cli/sdk";

function parsePmJson(stdout, commandLabel) {
  const trimmed = (stdout ?? "").trim();
  if (trimmed.length === 0) {
    return {};
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Failed to parse JSON from ${commandLabel}: ${error.message}`, { cause: error });
  }
}

function runPm(args) {
  const completed = spawnSync("pm", args, {
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
    },
  });
  if (completed.error) {
    throw new Error(`Failed to run pm ${args.join(" ")}: ${completed.error.message}`, { cause: completed.error });
  }
  if (completed.status !== 0) {
    const stderr = (completed.stderr ?? "").trim();
    throw new Error(stderr.length > 0 ? stderr : `pm ${args.join(" ")} failed with exit code ${completed.status}`);
  }
  return parsePmJson(completed.stdout, `pm ${args.join(" ")}`);
}

function resolveCommandForAction(action) {
  const commandMap = {
    "extension-reload": ["extension", "--reload", "--project", "--json"],
    "extension-doctor": ["extension", "--doctor", "--project", "--detail", "summary", "--json"],
    contracts: ["contracts", "--json"],
  };
  return commandMap[action] ?? [action, "--json"];
}

const requestedAction = (process.argv[2] ?? "extension-reload").trim().toLowerCase();
if (!isPmToolAction(requestedAction)) {
  throw new Error(`Unsupported pm action "${requestedAction}".`);
}

const contracts = runPm(["contracts", "--json"]);
const actionAvailability = Array.isArray(contracts.action_availability)
  ? contracts.action_availability.find((entry) => entry?.action === requestedAction) ?? null
  : null;
if (actionAvailability?.available === false) {
  throw new Error(
    `Action "${requestedAction}" is not available in this runtime (${actionAvailability.disabled_reason ?? "unknown_reason"}).`,
  );
}

const actionContract = PM_TOOL_ACTION_PARAMETER_CONTRACTS[requestedAction];
const command = resolveCommandForAction(requestedAction);
const commandResult = runPm(command);

process.stdout.write(
  `${JSON.stringify(
    {
      action: requestedAction,
      command: `pm ${command.join(" ")}`,
      required_parameters: actionContract.required ?? [],
      optional_parameters: actionContract.optional ?? [],
      policy_state: actionAvailability?.policy_state ?? null,
      result: commandResult,
    },
    null,
    2,
  )}\n`,
);
