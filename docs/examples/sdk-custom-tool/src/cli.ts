/**
 * @module docs/examples/sdk-custom-tool/cli
 *
 * Runs the SDK-only exemplar as a small domain CLI.
 */
import {
  runUniversalToolScenario,
  type UniversalToolScenarioOptions,
  type UniversalToolScenarioResult,
} from "./index.ts";

/** Scenario boundary accepted by the executable adapter. */
export type UniversalToolScenarioRunner = (
  options: UniversalToolScenarioOptions,
) => Promise<UniversalToolScenarioResult>;

/** Run the exemplar CLI against process-independent argument and I/O ports. */
export async function runUniversalToolCli(
  args: string[],
  author: string | undefined,
  writeOutput: (value: string) => void,
  writeError: (value: string) => void,
  runScenario: UniversalToolScenarioRunner = runUniversalToolScenario,
): Promise<number> {
  const workspace = args[0];
  if (!workspace) {
    writeError("Usage: pm-custom <workspace>\n");
    return 2;
  }
  const result = await runScenario({
    workspace,
    author: author ?? "pm-sdk-custom-tool",
  });
  writeOutput(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}
