import { pathExists } from "../../core/fs/fs-utils.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { locateItem, readLocatedItem } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { ItemFrontMatter, LinkedDoc, LinkedFile, LinkedTest } from "../../types/index.js";

export interface GetResult {
  item: ItemFrontMatter;
  body: string;
  linked: {
    files: LinkedFile[];
    tests: LinkedTest[];
    docs: LinkedDoc[];
  };
}

export async function runGet(id: string, global: GlobalOptions): Promise<GetResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
  const settings = await readSettings(pmRoot);
  const located = await locateItem(pmRoot, id, settings.id_prefix);
  if (!located) {
    throw new PmCliError(`Item ${id} not found`, EXIT_CODE.NOT_FOUND);
  }
  const loaded = await readLocatedItem(located);
  return {
    item: loaded.document.front_matter,
    body: loaded.document.body,
    linked: {
      files: loaded.document.front_matter.files ?? [],
      tests: loaded.document.front_matter.tests ?? [],
      docs: loaded.document.front_matter.docs ?? [],
    },
  };
}
