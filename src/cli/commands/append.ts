import { pathExists } from "../../core/fs/fs-utils.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { mutateItem } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";

export interface AppendCommandOptions {
  body: string;
  author?: string;
  message?: string;
  force?: boolean;
}

export interface AppendResult {
  item: Record<string, unknown>;
  appended: string;
  changed_fields: string[];
}

function resolveAuthor(candidate: string | undefined, defaultAuthor: string): string {
  const resolved = candidate ?? process.env.PM_AUTHOR ?? defaultAuthor;
  const trimmed = resolved.trim();
  return trimmed || "unknown";
}

export async function runAppend(id: string, options: AppendCommandOptions, global: GlobalOptions): Promise<AppendResult> {
  if (options.body === undefined) {
    throw new PmCliError("Missing required --body text", EXIT_CODE.USAGE);
  }
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
  const settings = await readSettings(pmRoot);
  const author = resolveAuthor(options.author, settings.author_default);
  const appended = options.body.trim();

  const result = await mutateItem({
    pmRoot,
    settings,
    id,
    op: "append",
    author,
    message: options.message,
    force: options.force,
    mutate(document) {
      if (appended.length === 0) {
        return { changedFields: [] };
      }
      const spacer = document.body.trim().length > 0 ? "\n\n" : "";
      document.body = `${document.body.replace(/\s+$/, "")}${spacer}${appended}\n`;
      return { changedFields: ["body"] };
    },
  });

  return {
    item: result.item as unknown as Record<string, unknown>,
    appended: appended.length > 0 ? appended : "",
    changed_fields: result.changedFields,
  };
}
