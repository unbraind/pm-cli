/**
 * @module cli/expected-revisions
 *
 * Binds the global `--expect-hash` flag (pm-gh1576) to one CLI invocation: the
 * scope wraps command parsing, the preAction hook binds canonical targets once
 * the tracker root and command arguments are known, and the invocation reports
 * expectations that no locked write ever evaluated.
 */
import type { Command } from "commander";
import {
  assertExpectHashAdmissible,
  bindItemRevisionScope,
  createItemRevisionScope,
  enrichItemRevisionConflict,
  itemRevisionScopeReceipt,
  itemRevisionUncheckedWarning,
  parseExpectHashSpecs,
  resolveExpectedItemRevisions,
  runWithItemRevisionScope,
  type ItemRevisionScope,
} from "../sdk/lifecycle/item-revision.js";
import { emitPreflightWarning } from "./preflight-warnings.js";

let activeScope: ItemRevisionScope | undefined;

/** Open the expected-revision scope for the next parsed invocation. */
export function openInvocationRevisionScope(): ItemRevisionScope {
  activeScope = createItemRevisionScope();
  return activeScope;
}

/** The first declared positional names the item a bare revision binds to. */
function itemArgumentOf(command: Command, commandArgs: readonly string[]): string | undefined {
  return command.registeredArguments[0]?.name() === "id" ? commandArgs[0] : undefined;
}

/** Bind `--expect-hash` tokens to canonical item ids before the command runs. */
export async function bindInvocationExpectedRevisions(params: {
  command: Command;
  commandPath: string;
  commandArgs: readonly string[];
  expectHash: readonly string[] | undefined;
  pmRoot: string;
}): Promise<void> {
  const specs = parseExpectHashSpecs(params.expectHash);
  if (specs.length === 0 || activeScope === undefined) return;
  assertExpectHashAdmissible(params.commandPath.trim().toLowerCase());
  const expectations = await resolveExpectedItemRevisions(params.pmRoot, specs, itemArgumentOf(params.command, params.commandArgs));
  bindItemRevisionScope(activeScope, params.pmRoot, expectations);
}

/** Warn about expectations whose item no locked write reached, then close the scope. */
export function reportInvocationRevisionScope(scope: ItemRevisionScope): void {
  if (activeScope === scope) activeScope = undefined;
  for (const id of itemRevisionScopeReceipt(scope).unchecked) {
    emitPreflightWarning(itemRevisionUncheckedWarning(id));
  }
}

/** Attach bounded change evidence to a revision refusal raised by this invocation. */
export async function enrichInvocationRevisionError(scope: ItemRevisionScope, error: unknown): Promise<unknown> {
  if (activeScope === scope) activeScope = undefined;
  return scope.pmRoot === undefined ? error : enrichItemRevisionConflict(error, scope.pmRoot);
}

/**
 * Run one invocation's parse inside a fresh expected-revision scope: `run`
 * receives a wrapper for the innermost parse call, so the scope sits inside any
 * caller-owned async contexts. Refusals gain change evidence; a successful
 * parse reports expectations no write reached.
 */
export async function parseWithInvocationRevisionScope(
  run: (parse: <T>(operation: () => Promise<T>) => Promise<T>) => Promise<unknown>,
): Promise<void> {
  const scope = openInvocationRevisionScope();
  try {
    await run((operation) => runWithItemRevisionScope(scope, operation));
  } catch (error: unknown) {
    throw await enrichInvocationRevisionError(scope, error);
  }
  reportInvocationRevisionScope(scope);
}
