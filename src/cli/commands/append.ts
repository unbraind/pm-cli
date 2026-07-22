/**
 * @module cli/commands/append
 *
 * Implements the pm append command surface and its agent-facing runtime behavior.
 */
import {
  pathExists,
  EXIT_CODE,
  type GlobalOptions,
  PmCliError,
  resolveAuthor,
  toItemRecord,
  createStdinTokenResolver,
  mutateItem,
  getSettingsPath,
  resolvePmRoot,
  readSettings,
} from "../../sdk/runtime-primitives.js";
/** Documents the append command options payload exchanged by command, SDK, and package integrations. */
export interface AppendCommandOptions {
  /** Value that configures or reports body for this contract. */
  body: string;
  /** Value that configures or reports author for this contract. */
  author?: string;
  /** Human-readable explanation suitable for logs and agent-facing output. */
  message?: string;
  /** Value that configures or reports force for this contract. */
  force?: boolean;
}

/** Documents the append result payload exchanged by command, SDK, and package integrations. */
export interface AppendResult {
  /** Value that configures or reports item for this contract. */
  item: Record<string, unknown>;
  /** Value that configures or reports appended for this contract. */
  appended: string;
  /** Value that configures or reports changed fields for this contract. */
  changed_fields: string[];
}

/** Implements run append for the public runtime surface of this module. */
export async function runAppend(
  id: string,
  options: AppendCommandOptions,
  global: GlobalOptions,
): Promise<AppendResult> {
  if (options.body === undefined) {
    throw new PmCliError("Missing required --body text", EXIT_CODE.USAGE);
  }
  const stdinResolver = createStdinTokenResolver();
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(
      `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  const settings = await readSettings(pmRoot);
  const author = resolveAuthor(options.author, settings.author_default);
  // options.body is guaranteed defined by the guard above, so resolveValue returns a defined string.
  const bodyInput = await stdinResolver.resolveValue(options.body, "--body");
  const appended = (bodyInput as string).trim();
  if (appended.length === 0) {
    throw new PmCliError(
      "--body text cannot be empty; append requires non-blank content and empty appends would only rewrite updated_at.",
      EXIT_CODE.USAGE,
      {
        code: "append_empty_body",
        required:
          "Provide non-empty body text positionally, via --body, or with - for stdin.",
        examples: [
          'pm append pm-a1b2 --body "Progress note"',
          "pm append pm-a1b2 --body -",
        ],
      },
    );
  }

  const result = await mutateItem({
    pmRoot,
    settings,
    id,
    op: "append",
    author,
    message: options.message,
    force: options.force,
    mutate(document) {
      const spacer = document.body.trim().length > 0 ? "\n\n" : "";
      document.body = `${document.body.replace(/\s+$/, "")}${spacer}${appended}\n`;
      return { changedFields: ["body"] };
    },
  });

  return {
    item: toItemRecord(result.item),
    appended,
    changed_fields: result.changedFields,
  };
}
