import { pathExists } from "../../core/fs/fs-utils.js";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { locateItem, readLocatedItem } from "../../core/store/item-store.js";
import { getHistoryPath, getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { ItemFrontMatter, LinkedDoc, LinkedFile, LinkedTest } from "../../types/index.js";
import { readHistoryEntries } from "./history.js";

interface ClaimHistoryContext {
  ts: string;
  author: string;
  message: string | null;
}

interface ClaimHistoryEntry {
  op: string;
  ts: string;
  author: string;
  message?: string;
}

interface ClaimStateContext {
  claimed: boolean;
  assignee: string | null;
  last_claim: ClaimHistoryContext | null;
  last_release: ClaimHistoryContext | null;
}

export interface GetResult {
  item: ItemFrontMatter;
  body: string;
  linked: {
    files: LinkedFile[];
    tests: LinkedTest[];
    docs: LinkedDoc[];
  };
  claim_state: ClaimStateContext;
}

function toClaimHistoryContext(
  entry: ClaimHistoryEntry,
): ClaimHistoryContext {
  return {
    ts: entry.ts,
    author: entry.author,
    message: entry.message ?? null,
  };
}

function resolveClaimStateContext(
  assigneeValue: string | undefined,
  history: ClaimHistoryEntry[],
): ClaimStateContext {
  const assignee = assigneeValue?.trim();
  const normalizedAssignee = assignee && assignee.length > 0 ? assignee : null;
  const lastClaim = [...history].reverse().find((entry) => entry.op === "claim");
  const lastRelease = [...history].reverse().find((entry) => entry.op === "release");
  return {
    claimed: normalizedAssignee !== null,
    assignee: normalizedAssignee,
    last_claim: lastClaim ? toClaimHistoryContext(lastClaim) : null,
    last_release: lastRelease ? toClaimHistoryContext(lastRelease) : null,
  };
}

export async function runGet(id: string, global: GlobalOptions): Promise<GetResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const located = await locateItem(pmRoot, id, settings.id_prefix, settings.item_format, typeRegistry.type_to_folder);
  if (!located) {
    throw new PmCliError(`Item ${id} not found`, EXIT_CODE.NOT_FOUND);
  }
  const loaded = await readLocatedItem(located, { schema: settings.schema });
  const historyPath = getHistoryPath(pmRoot, located.id);
  let history: ClaimHistoryEntry[] = [];
  try {
    history = await readHistoryEntries(historyPath, located.id);
  } catch {
    history = [];
  }
  return {
    item: loaded.document.front_matter,
    body: loaded.document.body,
    linked: {
      files: loaded.document.front_matter.files ?? [],
      tests: loaded.document.front_matter.tests ?? [],
      docs: loaded.document.front_matter.docs ?? [],
    },
    claim_state: resolveClaimStateContext(loaded.document.front_matter.assignee, history),
  };
}
