/**
 * @module sdk/workspace-recipe
 *
 * Defines serializable, versioned recipes for byte-reproducible pm workspace
 * executions in tests, examples, migrations, and package-author tooling.
 */
import {
  runWithReproducibleExecution,
  validateReproducibleExecutionSettings,
  type ReproducibleExecutionSettings,
} from "../core/reproducibility/context.js";

/** Current workspace recipe schema identifier. */
export const PM_WORKSPACE_RECIPE_SCHEMA =
  "https://schema.unbrained.dev/pm/workspace-recipe/v1";

/** Recursive JSON value accepted by portable workspace recipe inputs. */
export type WorkspaceRecipeJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly WorkspaceRecipeJsonValue[]
  | { readonly [key: string]: WorkspaceRecipeJsonValue };

/** One declared SDK or CLI operation in a reproducible workspace recipe. */
export interface WorkspaceRecipeOperation {
  /** Public action name understood by the caller-provided executor. */
  action: string;
  /** JSON-compatible action input forwarded without interpretation. */
  input: Readonly<Record<string, WorkspaceRecipeJsonValue>>;
}

/** Portable inputs required to replay a deterministic workspace execution. */
export interface WorkspaceRecipe extends ReproducibleExecutionSettings {
  /** Versioned recipe schema identifier. */
  schema: typeof PM_WORKSPACE_RECIPE_SCHEMA;
  /** Ordered operations executed inside the deterministic context. */
  operations: readonly WorkspaceRecipeOperation[];
}

type ExactWorkspaceRecipe<TRecipe extends WorkspaceRecipe> = TRecipe &
  Record<Exclude<keyof TRecipe, keyof WorkspaceRecipe>, never>;

function cloneAndFreezeRecipeJson(
  value: WorkspaceRecipeJsonValue,
  location: string,
): WorkspaceRecipeJsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Workspace recipe JSON number must be finite at ${location}`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(
      value.map((entry, index) =>
        cloneAndFreezeRecipeJson(entry, `${location}[${index}]`),
      ),
    );
  }
  if (
    typeof value !== "object" ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error(`Workspace recipe input must contain JSON values at ${location}`);
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        cloneAndFreezeRecipeJson(entry, `${location}.${key}`),
      ]),
    ),
  );
}

/** Validate and freeze a caller-authored reproducible workspace recipe. */
export function defineWorkspaceRecipe<const TRecipe extends WorkspaceRecipe>(
  recipe: ExactWorkspaceRecipe<TRecipe>,
): Readonly<TRecipe> {
  if (recipe.schema !== PM_WORKSPACE_RECIPE_SCHEMA) {
    throw new Error(`Unsupported workspace recipe schema: ${recipe.schema}`);
  }
  const normalized = validateReproducibleExecutionSettings(recipe);
  if (
    recipe.operations.some(
      (operation) =>
        operation.action.trim().length === 0 ||
        operation.input === null ||
        Array.isArray(operation.input),
    )
  ) {
    throw new Error("Workspace recipe operations require an action and object input");
  }
  return Object.freeze({
    ...normalized,
    operations: Object.freeze(
      recipe.operations.map((operation, index) =>
        Object.freeze({
          action: operation.action,
          input: cloneAndFreezeRecipeJson(
            operation.input,
            `operations[${index}].input`,
          ),
        }),
      ),
    ),
  }) as Readonly<TRecipe>;
}

/** Run arbitrary SDK work under the recipe's deterministic clock and entropy. */
export async function runWithWorkspaceRecipe<T>(
  recipe: WorkspaceRecipe,
  operation: () => Promise<T>,
): Promise<T> {
  const defined = defineWorkspaceRecipe(recipe);
  return runWithReproducibleExecution(defined, operation);
}

/** Replay every declared recipe operation with a caller-provided dispatcher. */
export async function executeWorkspaceRecipe<T>(
  recipe: WorkspaceRecipe,
  execute: (operation: WorkspaceRecipeOperation, index: number) => Promise<T>,
): Promise<T[]> {
  return runWithWorkspaceRecipe(recipe, async () => {
    const results: T[] = [];
    for (const [index, operation] of recipe.operations.entries()) {
      results.push(await execute(operation, index));
    }
    return results;
  });
}
