import { spawnSync } from "node:child_process";
import { PM_TOOL_ACTION_PARAMETER_CONTRACTS, isPmToolAction } from "@unbrained/pm-cli/sdk";

function parseContractsJson(stdout) {
  const trimmed = (stdout ?? "").trim();
  if (trimmed.length === 0) {
    return {};
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Failed to parse JSON from pm contracts: ${error.message}`, { cause: error });
  }
}

function runPmContracts() {
  const completed = spawnSync("pm", ["contracts", "--json"], {
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
    },
  });
  if (completed.error) {
    throw new Error(`Failed to run pm contracts: ${completed.error.message}`, { cause: completed.error });
  }
  if (completed.status !== 0) {
    const stderr = (completed.stderr ?? "").trim();
    throw new Error(stderr.length > 0 ? stderr : `pm contracts failed with exit code ${completed.status}`);
  }
  return parseContractsJson(completed.stdout);
}

const requestedAction = (process.argv[2] ?? "create").trim().toLowerCase();
if (!isPmToolAction(requestedAction)) {
  throw new Error(`Unsupported pm action "${requestedAction}".`);
}

const contracts = runPmContracts();
const availableActions = Array.isArray(contracts.actions) ? contracts.actions : [];
if (!availableActions.includes(requestedAction)) {
  throw new Error(`Action "${requestedAction}" is not currently invocable in this runtime.`);
}
const actionAvailability = Array.isArray(contracts.action_availability)
  ? contracts.action_availability.find((entry) => entry?.action === requestedAction) ?? null
  : null;
const extensionContracts =
  contracts.extension_contracts && typeof contracts.extension_contracts === "object" ? contracts.extension_contracts : null;

const actionContract = PM_TOOL_ACTION_PARAMETER_CONTRACTS[requestedAction];
const payload = {
  action: requestedAction,
  required_parameters: actionContract.required ?? [],
  optional_parameters: actionContract.optional ?? [],
  any_of_required_groups: actionContract.anyOfRequired ?? [],
  runtime_available: actionAvailability?.available === true,
  policy_state: actionAvailability?.policy_state ?? null,
  compatibility: extensionContracts?.compatibility ?? null,
  manifest_versions: extensionContracts?.manifest_versions ?? [],
};

process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
