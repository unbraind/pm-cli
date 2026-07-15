/**
 * @module cli/commands/eval
 *
 * Thin CLI adapter that binds canonical pm search to the SDK evaluation
 * harness. Custom SDK consumers can bind their own retrieval implementation.
 */
import {
  runSearchEval,
  type EvalOptions,
  type EvalResult,
  type GlobalOptions,
} from "../../sdk/eval.js";
import { runSearch } from "./search.js";

export * from "../../sdk/eval.js";

/** Run the SDK-owned relevance harness with pm's canonical search engine. */
export function runEval(
  options: EvalOptions,
  global: GlobalOptions,
): Promise<EvalResult> {
  return runSearchEval(options, global, runSearch);
}
