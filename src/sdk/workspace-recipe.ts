/**
 * @module sdk/workspace-recipe
 *
 * Defines serializable, versioned recipes for byte-reproducible pm workspace
 * executions in tests, examples, migrations, and package-author tooling.
 */
import {
  runWithReproducibleExecution,
  type ReproducibleExecutionSettings,
} from "../core/reproducibility/context.js";

/** Current workspace recipe schema identifier. */
export const PM_WORKSPACE_RECIPE_SCHEMA =
  "https://schema.unbrained.dev/pm/workspace-recipe/v1";

/** One declared SDK or CLI operation in a reproducible workspace recipe. */
export interface WorkspaceRecipeOperation {
  /** Public action name understood by the caller-provided executor. */
  action: string;
  /** JSON-compatible action input forwarded without interpretation. */
  input: Readonly<Record<string, unknown>>;
}

/** Portable inputs required to replay a deterministic workspace execution. */
export interface WorkspaceRecipe extends ReproducibleExecutionSettings {
  /** Versioned recipe schema identifier. */
  schema: typeof PM_WORKSPACE_RECIPE_SCHEMA;
  /** Ordered operations executed inside the deterministic context. */
  operations: readonly WorkspaceRecipeOperation[];
}

/** Validate and freeze a caller-authored reproducible workspace recipe. */
export function defineWorkspaceRecipe(
  recipe: WorkspaceRecipe,
): Readonly<WorkspaceRecipe> {
  if (recipe.schema !== PM_WORKSPACE_RECIPE_SCHEMA) {
    throw new Error(`Unsupported workspace recipe schema: ${recipe.schema}`);
  }
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
    ...recipe,
    operations: Object.freeze(
      recipe.operations.map((operation) =>
        Object.freeze({
          action: operation.action,
          input: Object.freeze({ ...operation.input }),
        }),
      ),
    ),
  });
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
