import { pathExists } from "../../core/fs/fs-utils.js";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { normalizeItemId } from "../../core/item/id.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import {
  clearFocusedItem,
  getFocusedItem,
  setFocusedItem,
} from "../../core/session/session-state.js";
import { buildItemNotFoundError, locateItem, readLocatedItem } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";

export interface FocusOptions {
  clear?: boolean;
}

export interface FocusResult {
  action: "set" | "clear" | "show";
  focused_item: string | null;
  title: string | null;
  message: string;
}

async function ensureInitialized(pmRoot: string): Promise<void> {
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
}

export async function runFocus(
  id: string | undefined,
  options: FocusOptions,
  global: GlobalOptions,
): Promise<FocusResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await ensureInitialized(pmRoot);

  const clear = options.clear === true;

  if (clear) {
    if (id !== undefined) {
      throw new PmCliError(
        "pm focus --clear does not take an item id. Use 'pm focus --clear' to clear focus or 'pm focus <id>' to set it.",
        EXIT_CODE.USAGE,
      );
    }
    await clearFocusedItem(pmRoot);
    return {
      action: "clear",
      focused_item: null,
      title: null,
      message: "Focus cleared. New items will not inherit a default parent.",
    };
  }

  if (id === undefined) {
    const current = await getFocusedItem(pmRoot);
    if (current === undefined) {
      return {
        action: "show",
        focused_item: null,
        title: null,
        message: "No focus set. Use 'pm focus <id>' to set a default parent for new items.",
      };
    }
    const title = await resolveFocusedTitle(pmRoot, current);
    return {
      action: "show",
      focused_item: current,
      title,
      message: `Focused on ${current}${title ? ` (${title})` : ""}. New items default --parent to it.`,
    };
  }

  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const located = await locateItem(pmRoot, id, settings.id_prefix, settings.item_format, typeRegistry.type_to_folder);
  if (!located) {
    throw await buildItemNotFoundError(pmRoot, id, settings.id_prefix, typeRegistry.type_to_folder);
  }
  const normalizedId = normalizeItemId(located.id, settings.id_prefix);
  const loaded = await readLocatedItem(located, { schema: settings.schema });
  const title = nonEmptyTitleOrNull(loaded.document.metadata.title);
  await setFocusedItem(pmRoot, normalizedId);
  return {
    action: "set",
    focused_item: normalizedId,
    title,
    message: `Focused on ${normalizedId}${title ? ` (${title})` : ""}. New items default --parent to it (override with --parent or clear via 'pm focus --clear').`,
  };
}

async function resolveFocusedTitle(pmRoot: string, id: string): Promise<string | null> {
  // The tracker is already known to be initialized (ensureInitialized ran), so
  // readSettings/locateItem behave like the `pm get` read path: a deleted/stale
  // focused item simply locates to null and yields no title hint.
  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const located = await locateItem(pmRoot, id, settings.id_prefix, settings.item_format, typeRegistry.type_to_folder);
  if (!located) {
    return null;
  }
  const loaded = await readLocatedItem(located, { schema: settings.schema });
  return nonEmptyTitleOrNull(loaded.document.metadata.title);
}

function nonEmptyTitleOrNull(title: string): string | null {
  return title.trim().length > 0 ? title : null;
}
