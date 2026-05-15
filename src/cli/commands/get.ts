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
  item: Partial<ItemFrontMatter>;
  body: string;
  linked: {
    files: LinkedFile[];
    tests: LinkedTest[];
    docs: LinkedDoc[];
  };
  claim_state: ClaimStateContext;
}

const GET_DEPTH_VALUES = ["brief", "standard", "deep"] as const;

type GetDepth = (typeof GET_DEPTH_VALUES)[number];

export interface GetOptions {
  depth?: string;
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

function parseGetDepth(raw: string | undefined): GetDepth {
  if (raw === undefined || raw.trim().length === 0) {
    return "deep";
  }
  const normalized = raw.trim().toLowerCase();
  if (GET_DEPTH_VALUES.includes(normalized as GetDepth)) {
    return normalized as GetDepth;
  }
  throw new PmCliError("Get --depth must be one of brief|standard|deep", EXIT_CODE.USAGE);
}

function projectItemForDepth(item: ItemFrontMatter, depth: GetDepth): Partial<ItemFrontMatter> {
  if (depth === "deep") {
    return item;
  }
  const {
    comments: _comments,
    notes: _notes,
    learnings: _learnings,
    files: _files,
    tests: _tests,
    docs: _docs,
    reminders: _reminders,
    events: _events,
    ...projected
  } = item;
  return projected;
}

export async function runGet(id: string, global: GlobalOptions, options: GetOptions = {}): Promise<GetResult> {
  const depth = parseGetDepth(options.depth);
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
  const files = loaded.document.metadata.files ?? [];
  const tests = loaded.document.metadata.tests ?? [];
  const docs = loaded.document.metadata.docs ?? [];
  return {
    item: projectItemForDepth(loaded.document.metadata, depth),
    body: depth === "brief" ? "" : loaded.document.body,
    linked: {
      files: depth === "brief" ? [] : files,
      tests: depth === "brief" ? [] : tests,
      docs: depth === "brief" ? [] : docs,
    },
    claim_state: resolveClaimStateContext(loaded.document.metadata.assignee, history),
  };
}
