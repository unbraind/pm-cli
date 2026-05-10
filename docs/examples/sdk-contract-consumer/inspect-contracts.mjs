import { spawnSync } from "node:child_process";
import { PM_TOOL_ACTION_PARAMETER_CONTRACTS, isPmToolAction } from "@unbrained/pm-cli/sdk";

function runPmContracts() {
  const completed = spawnSync("pm", ["contracts", "--json"], {
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
    },
  });
  if (completed.status !== 0) {
    const stderr = (completed.stderr ?? "").trim();
    throw new Error(stderr.length > 0 ? stderr : `pm contracts failed with exit code ${completed.status}`);
  }
  return JSON.parse(completed.stdout ?? "{}");
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

const actionContract = PM_TOOL_ACTION_PARAMETER_CONTRACTS[requestedAction];
const payload = {
  action: requestedAction,
  required_parameters: actionContract.required ?? [],
  optional_parameters: actionContract.optional ?? [],
  any_of_required_groups: actionContract.anyOfRequired ?? [],
};

process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
