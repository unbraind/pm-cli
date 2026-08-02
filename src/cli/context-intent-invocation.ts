/**
 * @module cli/context-intent-invocation
 *
 * Selects the CLI invocations that need active package intent declarations.
 */
import { parseBootstrapCommandName } from "../sdk/cli-bootstrap.js";

/** Load active-package context intents only when an invocation can consume them. */
export async function loadContextIntentSnapshotForInvocation<Snapshot>(
  invocationArgv: string[],
  pmRoot: string,
  noExtensions: boolean,
  loadSnapshot: (root: string) => Promise<Snapshot | null>,
): Promise<Snapshot | null> {
  if (noExtensions) return null;
  const requestsIntent = invocationArgv.some(
    (token) => token === "--for" || token.startsWith("--for="),
  );
  const requestsFullContracts =
    parseBootstrapCommandName(invocationArgv) === "contracts" &&
    invocationArgv.includes("--full");
  return requestsIntent || requestsFullContracts
    ? await loadSnapshot(pmRoot)
    : null;
}
