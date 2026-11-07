/**
 * @module cli/expected-revisions
 *
 * Binds the global `--expect-hash` flag (pm-gh1576) to one CLI invocation: the
 * scope wraps command parsing, the preAction hook binds canonical targets once
 * the tracker root and command arguments are known, and the invocation reports
 * expectations that no locked write ever evaluated. The binding scope travels
 * in AsyncLocalStorage, so overlapping in-process invocations never bind into
 * each other's scope.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Command } from "commander";
import {
  assertExpectHashAdmissible,
  bindItemRevisionScope,
  createItemRevisionScope,
  enrichItemRevisionConflict,
  expectHashInvocationRewrittenError,
  expectHashRequiresMutationError,
  itemRevisionScopeReceipt,
  itemRevisionUncheckedWarning,
  parseExpectHashSpecs,
  resolveExpectedItemRevisions,
  runWithItemRevisionScope,
  type ItemRevisionRecoveryInvocation,
  type ItemRevisionScope,
} from "../sdk/lifecycle/item-revision.js";
import { resolvePmCommandScopeArgs } from "../sdk/command-line.js";
import type { GlobalOptions } from "../sdk/runtime-primitives.js";
import { emitPreflightWarning } from "./preflight-warnings.js";

const invocationScopes = new AsyncLocalStorage<ItemRevisionScope>();
/** The tracker scope and output mode each bound invocation's revision refusals replay (pm-gh1677). */
const invocationRecoveries = new WeakMap<ItemRevisionScope, ItemRevisionRecoveryInvocation>();

/**
 * Recovery reads replay the caller's tracker scope, extension isolation and
 * output encoding. The canonical `--output-format` wins over the legacy
 * `--json`, as it does for the invocation's own output.
 */
export function invocationRevisionRecovery(globalOptions: GlobalOptions): ItemRevisionRecoveryInvocation {
  const outputArgs = globalOptions.outputFormat !== undefined
    ? ["--output-format", globalOptions.outputFormat]
    : globalOptions.json === true ? ["--json"] : [];
  return { scopeArgs: resolvePmCommandScopeArgs(globalOptions), outputArgs };
}
/** Invocation scopes whose guard preAction bound, with the command path admitted; final dispatch must not rewrite them. */
const guardedInvocations = new WeakMap<ItemRevisionScope, string>();

/**
 * The registered `id` positional names the item a bare revision binds to, at its
 * actual index (`plan` registers `[subcommand] [id]`). `plan create` takes its
 * title at that position, so it has no item to bind.
 */
function itemArgumentOf(command: Command, commandArgs: readonly string[]): string | undefined {
  const index = command.registeredArguments.findIndex((argument) => argument.name() === "id");
  if (index === -1 || (command.name() === "plan" && commandArgs[0] === "create")) return undefined;
  return commandArgs[index];
}

/** One view of the invocation an extension parser or preflight override produced. */
export interface InvocationStage {
  /** Command positionals as this stage sees them. */
  args: readonly string[];
  /** Tracker path option as this stage sees it (undefined for the default tracker). */
  path: string | undefined;
}

/**
 * Whether extension overrides rewrote the invocation's tracker or arguments.
 * Final dispatch, the injected extension SDK client and the preAction hook do
 * not all see the same rewritten view, so a guard cannot prove which item a
 * rewritten invocation writes.
 */
export function invocationRewritten(initial: InvocationStage, stages: readonly InvocationStage[]): boolean {
  return stages.some((stage) => stage.path !== initial.path || stage.args.length !== initial.args.length || stage.args.some((arg, index) => arg !== initial.args[index]));
}

/**
 * Bind `--expect-hash` tokens to canonical item ids before the command runs.
 * Tokens without an enclosing invocation scope (a command dispatched outside
 * {@link parseWithInvocationRevisionScope}) are refused rather than dropped.
 */
export async function bindInvocationExpectedRevisions(params: {
  command: Command;
  commandPath: string;
  commandArgs: readonly string[];
  expectHash: readonly string[] | undefined;
  pmRoot: string;
  /** Parsed command options, consulted for modes the guard cannot cover. */
  commandOptions?: Record<string, unknown>;
  /** Whether an extension parser or preflight override rewrote the tracker or arguments. */
  rewritten?: boolean;
  /** Global options whose tracker scope and output mode recovery commands replay. */
  globalOptions?: GlobalOptions;
}): Promise<void> {
  if (params.expectHash === undefined) return;
  const specs = parseExpectHashSpecs(params.expectHash);
  const action = params.commandPath.trim().toLowerCase();
  assertExpectHashAdmissible(action, params.commandOptions);
  if (params.rewritten === true) throw expectHashInvocationRewrittenError();
  const scope = invocationScopes.getStore();
  if (scope === undefined) throw new TypeError("--expect-hash was parsed outside an invocation revision scope");
  const expectations = await resolveExpectedItemRevisions(params.pmRoot, specs, itemArgumentOf(params.command, params.commandArgs));
  bindItemRevisionScope(scope, params.pmRoot, expectations);
  guardedInvocations.set(scope, action);
  if (params.globalOptions !== undefined) invocationRecoveries.set(scope, invocationRevisionRecovery(params.globalOptions));
}

/**
 * Refuse when a final-dispatch parser pass rewrites a guarded invocation. Commander
 * dispatch reruns extension parsers after preAction bound the guard to the typed
 * view, so each pass must keep that view's tracker and arguments, and the options
 * it dispatches with must stay admissible (no `--background` added late).
 */
export function assertGuardedDispatchUnchanged(input: InvocationStage, output: InvocationStage, options: Record<string, unknown>): void {
  const scope = invocationScopes.getStore();
  const action = scope === undefined ? undefined : guardedInvocations.get(scope);
  if (action === undefined) return;
  if (invocationRewritten(input, [output])) throw expectHashInvocationRewrittenError();
  assertExpectHashAdmissible(action, options);
}

/**
 * Inventory commands dispatch without lifecycle hooks and never write items, so a
 * guard on them is validated and refused instead of silently dropped.
 */
export function refuseInventoryExpectHash(commandPath: string, expectHash: readonly string[] | undefined): void {
  if (expectHash === undefined) return;
  parseExpectHashSpecs(expectHash);
  throw expectHashRequiresMutationError(commandPath);
}

/** Warn about each expectation whose item no locked write reached. */
export function reportInvocationRevisionScope(scope: ItemRevisionScope): void {
  for (const id of itemRevisionScopeReceipt(scope).unchecked) {
    emitPreflightWarning(itemRevisionUncheckedWarning(id));
  }
}

/** Attach bounded change evidence to a revision refusal raised by this invocation, with recovery reads scoped to it. */
export async function enrichInvocationRevisionError(scope: ItemRevisionScope, error: unknown): Promise<unknown> {
  return scope.pmRoot === undefined ? error : enrichItemRevisionConflict(error, scope.pmRoot, invocationRecoveries.get(scope));
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
  const scope = createItemRevisionScope();
  try {
    await run((operation) => invocationScopes.run(scope, () => runWithItemRevisionScope(scope, operation)));
  } catch (error: unknown) {
    throw await enrichInvocationRevisionError(scope, error);
  }
  reportInvocationRevisionScope(scope);
}
