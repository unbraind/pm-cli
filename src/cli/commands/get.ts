import { pathExists } from "../../core/fs/fs-utils.js";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { toItemRecord } from "../../core/item/item-record.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { resolveRuntimeFieldRegistry } from "../../core/schema/runtime-schema.js";
import { EXIT_CODE, FRONT_MATTER_KEY_ORDER } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { buildItemNotFoundError, locateItem, readLocatedItem } from "../../core/store/item-store.js";
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
  body?: string;
  linked?: {
    files: LinkedFile[];
    tests: LinkedTest[];
    docs: LinkedDoc[];
  };
  claim_state?: ClaimStateContext;
}

const GET_DEPTH_VALUES = ["brief", "standard", "deep"] as const;

type GetDepth = (typeof GET_DEPTH_VALUES)[number];

export interface GetOptions {
  depth?: string;
  fields?: string;
  full?: boolean;
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
  if (normalized === "full") {
    return "deep";
  }
  if (GET_DEPTH_VALUES.includes(normalized as GetDepth)) {
    return normalized as GetDepth;
  }
  throw new PmCliError("Get --depth must be one of brief|standard|deep|full", EXIT_CODE.USAGE);
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

function parseGetFields(raw: string | undefined): string[] | null {
  if (raw === undefined) {
    return null;
  }
  const fields = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (fields.length === 0) {
    throw new PmCliError("Get --fields requires a comma-separated list of field names", EXIT_CODE.USAGE);
  }
  return fields;
}

function normalizeGetField(field: string): string {
  return field.startsWith("item.") ? field.slice("item.".length) : field;
}

function validateGetFields(fields: string[] | null, runtimeMetadataKeys: Iterable<string>): void {
  if (fields === null) {
    return;
  }
  const itemFields = new Set([...FRONT_MATTER_KEY_ORDER, ...runtimeMetadataKeys]);
  const allowedRootFields = new Set(["body", "linked", "claim_state"]);
  const allowedLinkedFields = new Set(["linked.files", "linked.tests", "linked.docs"]);
  const allowedClaimStateFields = new Set(["claim_state.claimed", "claim_state.assignee", "claim_state.last_claim", "claim_state.last_release"]);
  const unknown = fields.filter((field) => {
    const normalized = normalizeGetField(field);
    return (
      !itemFields.has(normalized) &&
      !allowedRootFields.has(normalized) &&
      !allowedLinkedFields.has(normalized) &&
      !allowedClaimStateFields.has(normalized)
    );
  });
  if (unknown.length > 0) {
    throw new PmCliError(`Unknown get --fields value(s): ${unknown.join(", ")}`, EXIT_CODE.USAGE, {
      code: "unknown_field_projection",
      examples: [
        "pm get <id> --fields id,title,status,type,updated_at",
        "pm get <id> --fields id,title,claim_state",
        "pm get <id> --fields id,title,body,linked.files",
      ],
    });
  }
}

function projectItemForFields(item: ItemFrontMatter, fields: string[]): Partial<ItemFrontMatter> {
  const source = toItemRecord(item);
  const projected: Record<string, unknown> = {};
  for (const field of fields) {
    const normalized = field.startsWith("item.") ? field.slice("item.".length) : field;
    if (normalized === "body" || normalized === "linked" || normalized.startsWith("linked.")) {
      continue;
    }
    projected[normalized] = source[normalized];
  }
  return projected as Partial<ItemFrontMatter>;
}

function fieldsInclude(fields: string[] | null, name: string): boolean {
  return fields?.some((field) => field === name || field === `item.${name}`) ?? false;
}

function fieldsIncludeRoot(fields: string[], name: string): boolean {
  return fields.some((field) => field === name || field.startsWith(`${name}.`));
}

export async function runGet(id: string, global: GlobalOptions, options: GetOptions = {}): Promise<GetResult> {
  if (options.full && (options.fields !== undefined || options.depth !== undefined)) {
    throw new PmCliError("Get projection options are mutually exclusive; remove the extra projection flag and retry.", EXIT_CODE.USAGE);
  }
  const depth = options.full ? "deep" : parseGetDepth(options.depth);
  const fields = parseGetFields(options.fields);
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const located = await locateItem(pmRoot, id, settings.id_prefix, settings.item_format, typeRegistry.type_to_folder);
  if (!located) {
    throw await buildItemNotFoundError(pmRoot, id, settings.id_prefix, typeRegistry.type_to_folder);
  }
  const loaded = await readLocatedItem(located, { schema: settings.schema });
  const runtimeMetadataKeys: string[] = [];
  for (const field of resolveRuntimeFieldRegistry(settings.schema).definitions) {
    runtimeMetadataKeys.push(field.metadata_key);
  }
  validateGetFields(fields, runtimeMetadataKeys);
  const files = loaded.document.metadata.files ?? [];
  const tests = loaded.document.metadata.tests ?? [];
  const docs = loaded.document.metadata.docs ?? [];
  const fieldProjection = fields !== null;
  const includeBody = !fieldProjection ? depth !== "brief" : fieldsInclude(fields, "body");
  const includeLinked = !fieldProjection ? depth !== "brief" : fieldsInclude(fields, "linked");
  const includeLinkedFiles = includeLinked || fieldsInclude(fields, "linked.files");
  const includeLinkedTests = includeLinked || fieldsInclude(fields, "linked.tests");
  const includeLinkedDocs = includeLinked || fieldsInclude(fields, "linked.docs");
  const includeClaimState = !fieldProjection || fieldsIncludeRoot(fields, "claim_state");
  let claimState: ClaimStateContext | undefined;
  if (includeClaimState) {
    const historyPath = getHistoryPath(pmRoot, located.id);
    let history: ClaimHistoryEntry[] = [];
    try {
      history = await readHistoryEntries(historyPath, located.id);
    } catch {
      history = [];
    }
    claimState = resolveClaimStateContext(loaded.document.metadata.assignee, history);
  }
  const result: GetResult = {
    item: fieldProjection
      ? projectItemForFields(loaded.document.metadata, fields)
      : projectItemForDepth(loaded.document.metadata, depth),
  };
  if (!fieldProjection || includeBody) {
    result.body = includeBody ? loaded.document.body : "";
  }
  if (!fieldProjection || includeLinked || includeLinkedFiles || includeLinkedTests || includeLinkedDocs) {
    result.linked = {
      files: includeLinkedFiles ? files : [],
      tests: includeLinkedTests ? tests : [],
      docs: includeLinkedDocs ? docs : [],
    };
  }
  if (claimState) {
    result.claim_state = claimState;
  }
  return result;
}
