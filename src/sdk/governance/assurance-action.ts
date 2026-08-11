/**
 * @module sdk/assurance-action
 *
 * Normalizes the assurance action vocabulary once for CLI, SDK, and MCP hosts.
 */
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import {
  ASSURANCE_GATE_TRIGGERS,
  evaluateAssuranceGate,
  getAssuranceDeclaration,
  listAssuranceDeclarations,
  listAssuranceVerdicts,
  putAssuranceDeclaration,
  recordAssuranceVerdict,
  removeAssuranceDeclaration,
  type AssuranceAssertionDefinition,
  type AssuranceDeclaration,
  type AssuranceDeclarationKind,
  type AssuranceDocument,
  type AssuranceGateDefinition,
  type AssuranceGateVerdict,
  type AssuranceGateTrigger,
  type AssuranceMeasurementDefinition,
  type AssuranceMutationReceipt,
} from "./assurance.js";
import { MAX_ASSURANCE_VERDICT_LIMIT } from "./assurance-limits.js";
import { createAssuranceWorkspaceContext } from "./assurance-runtime.js";
import { resolvePmRoot } from "../runtime-primitives.js";
import { parseRuntimeInteger, readRuntimeString } from "../runtime-input.js";

/** Assurance registry and evaluation verbs shared by every transport. */
export const ASSURANCE_ACTIONS = [
  "list",
  "show",
  "put",
  "remove",
  "run",
  "verdicts",
] as const;

/** Assurance declaration kinds shared by every transport. */
export const ASSURANCE_DECLARATION_KINDS = [
  "measurement",
  "assertion",
  "gate",
] as const;

/** Assurance action verb. */
export type AssuranceAction = (typeof ASSURANCE_ACTIONS)[number];

/** Transport-neutral assurance action request. */
export interface AssuranceActionInput {
  /** CRUD, evaluation, or verdict-history action. */
  action: string;
  /** Declaration kind for registry actions. */
  kind?: string;
  /** Declaration id, gate id, or verdict gate filter. */
  id?: string;
  /** JSON object or serialized JSON declaration for put. */
  definition?: unknown;
  /** Lifecycle trigger for gate evaluation. */
  trigger?: string;
  /** Explicit commit, tree, or snapshot identity. */
  tree?: string;
  /** Verdict-history gate filter when id is used by another host field. */
  gate?: string;
  /** Maximum newest durable verdicts returned. */
  limit?: number | string;
  /** Evaluate without appending an immutable verdict. */
  dry_run?: boolean;
  /** Retain the complete mutation receipt; assurance receipts are complete by default. */
  fullChangedFields?: boolean;
  /** Project declaration mutations to their stable id. */
  idOnly?: boolean;
  /** Explicit author override. */
  author?: string;
  /** Audited mutation rationale. */
  message?: string;
}

/** Result union returned by transport-neutral assurance execution. */
export type AssuranceActionResult =
  | AssuranceDeclaration
  | AssuranceMutationReceipt
  | AssuranceGateVerdict
  | { /** Mutated declaration id. */ id: string }
  | {
      /** Registry declarations. */
      items: AssuranceDeclaration[];
      /** Number of declarations. */
      count: number;
      /** Stable row-selection contract. */
      row_contract: { row_keys: ["items"]; jq_selector: ".items[]" };
    }
  | {
      /** Durable gate verdicts. */
      items: AssuranceGateVerdict[];
      /** Number of verdicts. */
      count: number;
      /** Stable row-selection contract. */
      row_contract: { row_keys: ["items"]; jq_selector: ".items[]" };
    };

function parseAction(value: string): AssuranceAction {
  if (ASSURANCE_ACTIONS.includes(value as AssuranceAction)) {
    return value as AssuranceAction;
  }
  throw new PmCliError(
    `Unknown assurance action ${value}. Expected: ${ASSURANCE_ACTIONS.join(", ")}`,
    EXIT_CODE.USAGE,
  );
}

function parseKind(value: string | undefined): AssuranceDeclarationKind {
  if (
    value &&
    ASSURANCE_DECLARATION_KINDS.includes(value as AssuranceDeclarationKind)
  ) {
    return value as AssuranceDeclarationKind;
  }
  throw new PmCliError(
    `Assurance declaration kind is required. Expected: ${ASSURANCE_DECLARATION_KINDS.join(", ")}`,
    EXIT_CODE.USAGE,
  );
}

function parseDefinition(
  kind: AssuranceDeclarationKind,
  value: unknown,
): AssuranceDeclaration {
  let parsed = value;
  if (typeof value === "string") {
    if (!value.trim()) parsed = undefined;
    else {
      try {
        parsed = JSON.parse(value);
      } catch (error: unknown) {
        throw new PmCliError(
          "assurance definition must be valid JSON",
          EXIT_CODE.USAGE,
          { reason: error instanceof Error ? error.message : "invalid_json" },
        );
      }
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PmCliError(
      "assurance put requires a JSON object definition",
      EXIT_CODE.USAGE,
    );
  }
  if (kind === "measurement") return parsed as AssuranceMeasurementDefinition;
  if (kind === "assertion") return parsed as AssuranceAssertionDefinition;
  return parsed as AssuranceGateDefinition;
}

async function readDocument(pmRoot: string): Promise<AssuranceDocument> {
  const [measurements, assertions, gates] = await Promise.all([
    listAssuranceDeclarations(pmRoot, "measurement"),
    listAssuranceDeclarations(pmRoot, "assertion"),
    listAssuranceDeclarations(pmRoot, "gate"),
  ]);
  return {
    version: 1,
    measurements: measurements.items as AssuranceMeasurementDefinition[],
    assertions: assertions.items as AssuranceAssertionDefinition[],
    gates: gates.items as AssuranceGateDefinition[],
  };
}

/** Apply the common id-only projection without weakening the full audit receipt. */
function projectMutationReceipt(
  receipt: AssuranceMutationReceipt,
  idOnly: boolean | undefined,
): AssuranceMutationReceipt | { id: string } {
  return idOnly === true ? { id: receipt.id } : receipt;
}

async function normalizeAssuranceMutation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      throw new PmCliError(error.message, EXIT_CODE.USAGE, {
        code: "invalid_argument_value",
        reason: "assurance_mutation_refused",
      });
    }
    throw error;
  }
}

async function authorizedDecisionIds(
  pmRoot: string,
  definition: AssuranceAssertionDefinition,
): Promise<string[]> {
  const decisionId = definition.authorization_decision;
  if (!decisionId) return [];
  const context = await createAssuranceWorkspaceContext(pmRoot, {
    include_history: false,
    resolve_tree: false,
  });
  const decision = context.items.find((item) => item.id === decisionId);
  const terminalStatuses = new Set(context.terminal_statuses!);
  if (
    !decision ||
    decision.type.toLowerCase() !== "decision" ||
    !terminalStatuses.has(decision.status)
  ) {
    throw new PmCliError(
      `Assurance authorization ${decisionId} must name a terminal Decision item`,
      EXIT_CODE.USAGE,
    );
  }
  return [decision.id];
}

/** Validate and execute the bounded durable-verdict listing transport. */
async function runVerdictsAction(
  input: AssuranceActionInput,
  pmRoot: string,
): Promise<Extract<AssuranceActionResult, { items: AssuranceGateVerdict[] }>> {
  const limit = parseRuntimeInteger(input.limit, "assurance verdict limit");
  if (
    limit !== undefined &&
    (limit < 1 || limit > MAX_ASSURANCE_VERDICT_LIMIT)
  ) {
    throw new PmCliError(
      `assurance verdict limit must be an integer from 1 through ${MAX_ASSURANCE_VERDICT_LIMIT}`,
      EXIT_CODE.USAGE,
    );
  }
  const items = await listAssuranceVerdicts(pmRoot, {
    gate_id: input.id ?? input.gate,
    limit,
  });
  return {
    items,
    count: items.length,
    row_contract: { row_keys: ["items"] as const, jq_selector: ".items[]" },
  };
}

/** Execute one assurance request through the public assurance SDK primitives. */
export async function runAssuranceAction(
  input: AssuranceActionInput,
  global: Pick<GlobalOptions, "path"> = {},
): Promise<AssuranceActionResult> {
  const action = parseAction(input.action);
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (action === "verdicts") {
    return runVerdictsAction(input, pmRoot);
  }
  if (action === "run") {
    if (!input.id) {
      throw new PmCliError("assurance run requires a gate id", EXIT_CODE.USAGE);
    }
    if (!input.trigger) {
      throw new PmCliError("assurance run requires a trigger", EXIT_CODE.USAGE);
    }
    if (!ASSURANCE_GATE_TRIGGERS.includes(input.trigger as AssuranceGateTrigger)) {
      throw new PmCliError(
        `Unknown assurance trigger ${input.trigger}. Expected: ${ASSURANCE_GATE_TRIGGERS.join(", ")}`,
        EXIT_CODE.USAGE,
      );
    }
    const [document, workspaceContext] = await Promise.all([
      readDocument(pmRoot),
      createAssuranceWorkspaceContext(pmRoot, { tree_id: input.tree }),
    ]);
    const verdict = await evaluateAssuranceGate(
      input.id,
      document,
      workspaceContext,
      {
        trigger: input.trigger as AssuranceGateTrigger,
        dry_run: input.dry_run === true,
      },
    );
    if (!verdict.dry_run) {
      await recordAssuranceVerdict(pmRoot, verdict, {
        author: input.author,
        message: input.message,
      });
    }
    return verdict;
  }
  const kind = parseKind(input.kind);
  if (action === "list") return listAssuranceDeclarations(pmRoot, kind);
  if (!input.id) {
    throw new PmCliError(`assurance ${action} requires an id`, EXIT_CODE.USAGE);
  }
  const id = input.id;
  if (action === "show") {
    return getAssuranceDeclaration(pmRoot, kind, id);
  }
  if (action === "remove") {
    const receipt = await normalizeAssuranceMutation(() =>
      removeAssuranceDeclaration(
        pmRoot,
        kind,
        id,
        { author: input.author, message: input.message },
      ),
    );
    return projectMutationReceipt(receipt, input.idOnly);
  }
  const definition = parseDefinition(kind, input.definition);
  if (definition.id !== id) {
    throw new PmCliError(
      `Assurance definition id ${definition.id} does not match requested id ${id}`,
      EXIT_CODE.USAGE,
    );
  }
  const mutationOptions = {
    author: input.author,
    message: input.message,
    ...(kind === "assertion"
      ? {
          authorized_decision_ids: await authorizedDecisionIds(
            pmRoot,
            definition as AssuranceAssertionDefinition,
          ),
        }
      : {}),
  };
  const receipt = await normalizeAssuranceMutation(() =>
    putAssuranceDeclaration(
      pmRoot,
      kind,
      definition,
      mutationOptions,
    ),
  );
  return projectMutationReceipt(receipt, input.idOnly);
}

/** Normalize a generic SDK or MCP argument envelope into one assurance request. */
export function runAssuranceDispatch(
  args: Record<string, unknown>,
  options: Record<string, unknown>,
  global: GlobalOptions,
): Promise<AssuranceActionResult> {
  const merged = { ...args, ...options };
  return runAssuranceAction(
    {
      action:
        readRuntimeString(merged, "subcommand") ??
        readRuntimeString(merged, "assuranceAction") ??
        readRuntimeString(merged, "operation") ??
        "",
      kind: readRuntimeString(merged, "kind"),
      id: readRuntimeString(merged, "id"),
      definition: merged.definition,
      trigger: readRuntimeString(merged, "trigger"),
      tree:
        readRuntimeString(merged, "treeId") ??
        readRuntimeString(merged, "tree"),
      gate: readRuntimeString(merged, "gate"),
      limit: parseRuntimeInteger(merged.limit, "assurance verdict limit"),
      dry_run: merged.dryRun === true || merged.dry_run === true,
      fullChangedFields: merged.fullChangedFields === true,
      idOnly: merged.idOnly === true,
      author: readRuntimeString(merged, "author"),
      message: readRuntimeString(merged, "message"),
    },
    global,
  );
}
