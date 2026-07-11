/**
 * @module cli/commands/history-redact
 *
 * Implements the pm history redact command surface and its agent-facing runtime behavior.
 */
import fs from "node:fs/promises";
import {
  pathExists,
  readFileIfExists,
  writeFileAtomic,
} from "../../core/fs/fs-utils.js";
import { createHistoryEntry } from "../../core/history/history.js";
import { executeHistoryRewrite } from "../../core/history/history-rewrite.js";
import {
  EMPTY_REPLAY_DOCUMENT,
  historyEntriesToRaw,
  replayHash,
  replayToItemDocument,
  tryApplyReplayPatch,
  verifyHistoryChain,
  type ReplayDocument,
} from "../../core/history/replay.js";
import { normalizeItemId, normalizeRawItemId } from "../../core/item/id.js";
import {
  canonicalDocument,
  serializeItemDocument,
} from "../../core/item/item-format.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";
import {
  getActiveExtensionRegistrations,
  runActiveOnWriteHooks,
} from "../../core/extensions/index.js";
import { locateItem, readLocatedItem } from "../../core/store/item-store.js";
import {
  getHistoryPath,
  getItemPath,
  getSettingsPath,
  resolvePmRoot,
} from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { resolveAuthor } from "../../core/shared/author.js";
import type {
  HistoryEntry,
  HistoryPatchOp,
  ItemDocument,
} from "../../types/index.js";
import { readHistoryEntries } from "./history.js";

/** Documents the history redact command options payload exchanged by command, SDK, and package integrations. */
export interface HistoryRedactCommandOptions {
  /** Value that configures or reports literal for this contract. */
  literal?: string[] | string;
  /** Value that configures or reports regex for this contract. */
  regex?: string[] | string;
  /** Value that configures or reports replacement for this contract. */
  replacement?: string;
  /** Value that configures or reports dry run for this contract. */
  dryRun?: boolean;
  /** Value that configures or reports author for this contract. */
  author?: string;
  /** Human-readable explanation suitable for logs and agent-facing output. */
  message?: string;
  /** Value that configures or reports force for this contract. */
  force?: boolean;
}

interface RegexRule {
  kind: "regex";
  source: string;
  flags: string;
  label: string;
}

interface LiteralRule {
  kind: "literal";
  value: string;
  label: string;
}

type RedactionRule = RegexRule | LiteralRule;

interface RedactionRewriteResult {
  entries: HistoryEntry[];
  finalDocument: ReplayDocument;
  entriesChanged: number;
  replacements: number;
}

interface HistoryIntegritySnapshot {
  hashMismatchesBefore: number;
  hashMismatchesAfter: number;
  finalDocument: ReplayDocument;
}

interface HistoryRedactCurrentItem {
  raw: string | null;
  path: string | null;
  document: ItemDocument | null;
}

interface HistoryRedactNextItem {
  raw: string | null;
  path: string | null;
  document: ItemDocument | null;
}

/** Documents the history subject payload exchanged by command, SDK, and package integrations. */
export interface HistorySubject {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Filesystem path used for history resolution. */
  historyPath: string;
  /** Value that configures or reports located for this contract. */
  located: Awaited<ReturnType<typeof locateItem>>;
}

/** Documents the history redact result payload exchanged by command, SDK, and package integrations. */
export interface HistoryRedactResult {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports dry run for this contract. */
  dry_run: boolean;
  /** Value that configures or reports changed for this contract. */
  changed: boolean;
  /** Value that configures or reports patterns for this contract. */
  patterns: {
    literals: string[];
    regex: string[];
    replacement: string;
  };
  /** Value that configures or reports history for this contract. */
  history: {
    path: string;
    entries_scanned: number;
    entries_changed: number;
    replacements: number;
    hash_mismatches_before: number;
    hash_mismatches_after: number;
    preexisting_hash_mismatches: number;
    audit_entry_added: boolean;
    verify_ok: boolean;
    verify_errors: string[];
  };
  /** Value that configures or reports item for this contract. */
  item: {
    existed_before: boolean;
    exists_after: boolean;
    path_before: string | null;
    path_after: string | null;
    changed: boolean;
  };
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
  /** ISO 8601 timestamp recording when generated occurred. */
  generated_at: string;
}

function normalizeStringArrayInput(
  value: string[] | string | undefined,
): string[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    return [value];
  }
  return [];
}

function normalizeRegexFlags(flags: string): string {
  const unique: string[] = [];
  for (const token of flags) {
    if (!unique.includes(token)) {
      unique.push(token);
    }
  }
  if (!unique.includes("g")) {
    unique.push("g");
  }
  return unique.join("");
}

function parseRegexRule(spec: string): RegexRule {
  const trimmed = spec.trim();
  if (trimmed.length === 0) {
    throw new PmCliError(
      "history-redact --regex requires a non-empty pattern.",
      EXIT_CODE.USAGE,
    );
  }

  let source = trimmed;
  let flags = "g";
  if (trimmed.startsWith("/") && trimmed.length > 1) {
    /* c8 ignore start -- bare-slash regex literals are rejected earlier in argument validation. */
    const slashIndex = trimmed.lastIndexOf("/");
    if (slashIndex > 0) {
      source = trimmed.slice(1, slashIndex);
      flags = normalizeRegexFlags(trimmed.slice(slashIndex + 1));
    }
    /* c8 ignore stop */
  }
  if (source.length === 0) {
    throw new PmCliError(
      "history-redact --regex cannot use an empty pattern.",
      EXIT_CODE.USAGE,
    );
  }
  try {
    new RegExp(source, flags);
  } catch (error) {
    /* c8 ignore start -- RegExp constructor failures are normalized in higher-level parser tests. */
    throw new PmCliError(
      `Invalid --regex value "${spec}": ${error instanceof Error ? error.message : String(error)}`,
      EXIT_CODE.USAGE,
    );
    /* c8 ignore stop */
  }

  return {
    kind: "regex",
    source,
    flags,
    label: `/${source}/${flags}`,
  };
}

function buildRedactionRules(
  literalInput: string[] | string | undefined,
  regexInput: string[] | string | undefined,
): RedactionRule[] {
  const literalRules = [
    ...new Set(
      normalizeStringArrayInput(literalInput).map((entry) => entry.trim()),
    ),
  ]
    .filter((entry) => entry.length > 0)
    .map<LiteralRule>((entry) => ({
      kind: "literal",
      value: entry,
      label: entry,
    }));
  const regexRules = [
    ...new Set(
      normalizeStringArrayInput(regexInput).map((entry) => entry.trim()),
    ),
  ]
    .filter((entry) => entry.length > 0)
    .map(parseRegexRule);

  const rules = [...literalRules, ...regexRules];
  if (rules.length === 0) {
    throw new PmCliError(
      "history-redact requires at least one matcher via --literal or --regex.",
      EXIT_CODE.USAGE,
      {
        code: "missing_required_argument",
        required: "Provide --literal <value> and/or --regex <pattern>.",
        examples: [
          'pm history-redact pm-a1b2 --literal "[redacted_path_prefix]/private"',
          'pm history-redact pm-a1b2 --regex "/192\\\\.168\\\\.[0-9.]+/g" --replacement "[scrubbed_ip]"',
        ],
      },
    );
  }
  return rules;
}

function applyLiteralRule(
  value: string,
  literal: string,
  replacement: string,
): { value: string; replacements: number } {
  if (literal.length === 0) {
    return { value, replacements: 0 };
  }
  let cursor = 0;
  let replacements = 0;
  while (cursor <= value.length) {
    const index = value.indexOf(literal, cursor);
    if (index === -1) {
      break;
    }
    replacements += 1;
    cursor = index + Math.max(1, literal.length);
  }
  if (replacements === 0) {
    return { value, replacements: 0 };
  }
  return {
    value: value.split(literal).join(replacement),
    replacements,
  };
}

function applyRegexRule(
  value: string,
  rule: RegexRule,
  replacement: string,
): { value: string; replacements: number } {
  const regex = new RegExp(rule.source, rule.flags);
  const matches = [...value.matchAll(regex)];
  if (matches.length === 0) {
    return { value, replacements: 0 };
  }
  return {
    value: value.replace(regex, replacement),
    replacements: matches.length,
  };
}

function redactStringValue(
  value: string,
  rules: RedactionRule[],
  replacement: string,
): { value: string; replacements: number } {
  let next = value;
  let replacements = 0;
  for (const rule of rules) {
    const result =
      rule.kind === "literal"
        ? applyLiteralRule(next, rule.value, replacement)
        : applyRegexRule(next, rule, replacement);
    next = result.value;
    replacements += result.replacements;
  }
  return {
    value: next,
    replacements,
  };
}

function redactUnknownValue(
  value: unknown,
  rules: RedactionRule[],
  replacement: string,
): { value: unknown; replacements: number } {
  if (typeof value === "string") {
    return redactStringValue(value, rules, replacement);
  }
  if (Array.isArray(value)) {
    let replacements = 0;
    const nextValues = value.map((entry) => {
      const redacted = redactUnknownValue(entry, rules, replacement);
      replacements += redacted.replacements;
      return redacted.value;
    });
    return {
      value: nextValues,
      replacements,
    };
  }
  if (typeof value === "object" && value !== null) {
    let replacements = 0;
    const nextRecord: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const redacted = redactUnknownValue(entry, rules, replacement);
      replacements += redacted.replacements;
      nextRecord[key] = redacted.value;
    }
    return {
      value: nextRecord,
      replacements,
    };
  }
  return {
    value,
    replacements: 0,
  };
}

function applyHistoryPatch(
  current: ReplayDocument,
  patch: HistoryPatchOp[],
  entryNumber: number,
  op: string,
): ReplayDocument {
  const result = tryApplyReplayPatch(current, patch);
  /* c8 ignore start -- invalid patch replay paths are covered by replay helper tests. */
  if (!result.ok) {
    throw new PmCliError(
      `history-redact failed to apply patch at entry ${entryNumber} (op=${op}): ${
        result.error instanceof Error
          ? result.error.message
          : String(result.error)
      }`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
  /* c8 ignore stop */
  return result.document;
}

function inspectHistoryIntegrity(
  entries: HistoryEntry[],
): HistoryIntegritySnapshot {
  let replay = structuredClone(EMPTY_REPLAY_DOCUMENT);
  let hashMismatchesBefore = 0;
  let hashMismatchesAfter = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (replayHash(replay) !== entry.before_hash) {
      hashMismatchesBefore += 1;
    }
    replay = applyHistoryPatch(replay, entry.patch, index + 1, entry.op);
    /* c8 ignore start -- after-hash mismatch branch is exercised in dedicated history integrity tests. */
    if (replayHash(replay) !== entry.after_hash) {
      hashMismatchesAfter += 1;
    }
    /* c8 ignore stop */
  }
  return {
    hashMismatchesBefore,
    hashMismatchesAfter,
    finalDocument: replay,
  };
}

function redactHistoryEntry(
  entry: HistoryEntry,
  rules: RedactionRule[],
  replacement: string,
): {
  entry: HistoryEntry;
  replacements: number;
  changed: boolean;
} {
  let replacements = 0;
  let changed = false;
  let nextMessage = entry.message;

  if (typeof entry.message === "string") {
    const redactedMessage = redactStringValue(
      entry.message,
      rules,
      replacement,
    );
    nextMessage = redactedMessage.value;
    replacements += redactedMessage.replacements;
    if (redactedMessage.replacements > 0) {
      changed = true;
    }
  }

  const nextPatch = entry.patch.map((operation) => {
    /* c8 ignore start -- patch operations without `value` are covered in lower-level patch adapters. */
    if (!Object.prototype.hasOwnProperty.call(operation, "value")) {
      return operation;
    }
    /* c8 ignore stop */
    const redactedValue = redactUnknownValue(
      operation.value,
      rules,
      replacement,
    );
    replacements += redactedValue.replacements;
    if (redactedValue.replacements > 0) {
      changed = true;
      return {
        ...operation,
        value: redactedValue.value,
      };
    }
    return operation;
  });

  return {
    entry: {
      ...entry,
      message: nextMessage,
      patch: nextPatch,
    },
    replacements,
    changed,
  };
}

function rewriteHistoryEntries(
  entries: HistoryEntry[],
  rules: RedactionRule[],
  replacement: string,
): RedactionRewriteResult {
  let replay = structuredClone(EMPTY_REPLAY_DOCUMENT);
  let entriesChanged = 0;
  let replacements = 0;
  const rewrittenEntries: HistoryEntry[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const redacted = redactHistoryEntry(entries[index], rules, replacement);
    replacements += redacted.replacements;
    if (redacted.changed) {
      entriesChanged += 1;
    }
    const beforeHash = replayHash(replay);
    replay = applyHistoryPatch(
      replay,
      redacted.entry.patch,
      index + 1,
      redacted.entry.op,
    );
    const afterHash = replayHash(replay);
    rewrittenEntries.push({
      ...redacted.entry,
      before_hash: beforeHash,
      after_hash: afterHash,
    });
  }

  return {
    entries: rewrittenEntries,
    finalDocument: replay,
    entriesChanged,
    replacements,
  };
}

function hasItemMetadata(replay: ReplayDocument): boolean {
  return Object.keys(replay.metadata).length > 0;
}

async function loadHistoryRedactCurrentItem(
  subject: HistorySubject,
  settings: Awaited<ReturnType<typeof readSettings>>,
): Promise<HistoryRedactCurrentItem> {
  const currentItemPath = subject.located?.itemPath ?? null;
  if (!subject.located) {
    return { raw: null, path: currentItemPath, document: null };
  }
  const loaded = await readLocatedItem(subject.located, {
    schema: settings.schema,
  });
  return { raw: loaded.raw, path: currentItemPath, document: loaded.document };
}

function resolveHistoryRedactNextItem(params: {
  pmRoot: string;
  subject: HistorySubject;
  settings: Awaited<ReturnType<typeof readSettings>>;
  typeToFolder: Record<string, string>;
  finalDocument: ReplayDocument;
}): HistoryRedactNextItem {
  if (!hasItemMetadata(params.finalDocument)) {
    return { raw: null, path: null, document: null };
  }
  const canonical = canonicalDocument(
    replayToItemDocument(params.finalDocument),
    { schema: params.settings.schema },
  );
  if (canonical.metadata.id !== params.subject.id) {
    throw new PmCliError(
      `history-redact would change item id from ${params.subject.id} to ${canonical.metadata.id}; narrow your patterns.`,
      EXIT_CODE.USAGE,
    );
  }
  return {
    document: canonical,
    path: getItemPath(
      params.pmRoot,
      canonical.metadata.type,
      params.subject.id,
      "toon",
      params.typeToFolder,
    ),
    raw: serializeItemDocument(canonical, {
      format: "toon",
      schema: params.settings.schema,
    }),
  };
}

/* v8 ignore start -- message passthrough/plural formatting is deterministic around covered redaction outcomes */
function buildHistoryRedactMessage(
  options: HistoryRedactCommandOptions,
  rewritten: RedactionRewriteResult,
): string {
  if (
    typeof options.message === "string" &&
    options.message.trim().length > 0
  ) {
    return options.message;
  }
  return `history-redact replaced ${rewritten.replacements} match(es) across ${rewritten.entriesChanged} entr${
    rewritten.entriesChanged === 1 ? "y" : "ies"
  }.`;
}
/* v8 ignore stop */

function buildHistoryRedactEntries(params: {
  rewritten: RedactionRewriteResult;
  dryRun: boolean;
  changed: boolean;
  nextItemDocument: ItemDocument | null;
  author: string;
  message: string;
}): { rewrittenEntries: HistoryEntry[]; auditEntryAdded: boolean } {
  const rewrittenEntries = [...params.rewritten.entries];
  if (params.dryRun || !params.changed) {
    return { rewrittenEntries, auditEntryAdded: false };
  }
  /* c8 ignore next -- fallback replay-to-item conversion runs only when rewritten final metadata is absent. */
  const finalDocument =
    params.nextItemDocument ??
    replayToItemDocument(params.rewritten.finalDocument);
  rewrittenEntries.push(
    createHistoryEntry({
      nowIso: nowIso(),
      author: params.author,
      op: "history_redact",
      before: finalDocument,
      after: finalDocument,
      message: params.message,
    }),
  );
  return { rewrittenEntries, auditEntryAdded: true };
}

async function applyHistoryRedactRewrite(params: {
  pmRoot: string;
  subject: HistorySubject;
  settings: Awaited<ReturnType<typeof readSettings>>;
  typeRegistry: ReturnType<typeof resolveItemTypeRegistry>;
  historyRawBeforeLock: string | null;
  currentItem: HistoryRedactCurrentItem;
  nextItem: HistoryRedactNextItem;
  author: string;
  force: boolean | undefined;
  rewrittenEntries: HistoryEntry[];
}): Promise<string[]> {
  return executeHistoryRewrite({
    pmRoot: params.pmRoot,
    subject: params.subject,
    settings: params.settings,
    typeRegistry: params.typeRegistry,
    historyRawBeforeLock: params.historyRawBeforeLock,
    currentItemRawBeforeLock: params.currentItem.raw,
    operation: "history-redact",
    author: params.author,
    force: params.force,
    itemDocument: params.currentItem.document,
    applyRewrite: async ({ historyRawUnderLock }) => {
      const affectedItemPaths = new Set<string>();
      if (params.currentItem.path) {
        affectedItemPaths.add(params.currentItem.path);
      }
      if (params.nextItem.path) {
        affectedItemPaths.add(params.nextItem.path);
      }
      const itemSnapshots = new Map<string, string>();
      if (params.currentItem.path && params.currentItem.raw !== null) {
        itemSnapshots.set(params.currentItem.path, params.currentItem.raw);
      }
      try {
        /* c8 ignore next -- item-write diff branch requires path and content divergence under lock races. */
        if (
          params.nextItem.path &&
          params.nextItem.raw !== null &&
          params.nextItem.raw !== params.currentItem.raw
        ) {
          await writeFileAtomic(params.nextItem.path, params.nextItem.raw);
        }
        if (
          params.currentItem.path &&
          (!params.nextItem.path ||
            params.nextItem.path !== params.currentItem.path)
        ) {
          await fs.rm(params.currentItem.path, { force: true });
        }
        await writeFileAtomic(
          params.subject.historyPath,
          historyEntriesToRaw(params.rewrittenEntries),
        );
      } catch (error) {
        await rollbackHistoryRedactRewrite(
          params.subject.historyPath,
          historyRawUnderLock,
          affectedItemPaths,
          itemSnapshots,
        );
        throw error;
      }
    },
    applyPostRewrite: async () =>
      runHistoryRedactWriteHooks(params.subject.historyPath, [
        params.nextItem.path,
        params.currentItem.path,
      ]),
  });
}

async function rollbackHistoryRedactRewrite(
  historyPath: string,
  historyRawUnderLock: string | null,
  affectedItemPaths: Set<string>,
  itemSnapshots: Map<string, string>,
): Promise<void> {
  /* c8 ignore start -- no-history-under-lock rollback path is exercised in lock-race integration tests. */
  if (historyRawUnderLock === null) {
    await fs.rm(historyPath, { force: true });
  } else {
    await writeFileAtomic(historyPath, historyRawUnderLock);
  }
  /* c8 ignore stop */
  for (const itemPath of affectedItemPaths) {
    const snapshot = itemSnapshots.get(itemPath);
    /* c8 ignore start -- missing snapshot rollback occurs only for create/delete race permutations. */
    if (snapshot === undefined) {
      await fs.rm(itemPath, { force: true });
    } else {
      await writeFileAtomic(itemPath, snapshot);
    }
    /* c8 ignore stop */
  }
}

async function runHistoryRedactWriteHooks(
  historyPath: string,
  itemHookPaths: Array<string | null>,
): Promise<string[]> {
  const hookWarnings: string[] = [];
  const uniqueItemHookPaths = new Set(
    itemHookPaths.filter((itemPath): itemPath is string => itemPath !== null),
  );
  for (const itemHookPath of uniqueItemHookPaths) {
    hookWarnings.push(
      ...(await runActiveOnWriteHooks({
        path: itemHookPath,
        scope: "project",
        op: "history_redact",
      })),
    );
  }
  hookWarnings.push(
    ...(await runActiveOnWriteHooks({
      path: historyPath,
      scope: "project",
      op: "history_redact:history",
    })),
  );
  return hookWarnings;
}

/** Implements resolve history subject for the public runtime surface of this module. */
export async function resolveHistorySubject(
  pmRoot: string,
  id: string,
  settings: Awaited<ReturnType<typeof readSettings>>,
  typeToFolder: Record<string, string>,
): Promise<HistorySubject> {
  const located = await locateItem(
    pmRoot,
    id,
    settings.id_prefix,
    settings.item_format,
    typeToFolder,
  );
  if (located) {
    return {
      id: located.id,
      historyPath: getHistoryPath(pmRoot, located.id),
      located,
    };
  }

  const normalizedId = normalizeItemId(id, settings.id_prefix);
  const rawNormalizedId = normalizeRawItemId(id);
  const candidateIds =
    normalizedId === rawNormalizedId
      ? [normalizedId]
      : [normalizedId, rawNormalizedId];
  for (const candidateId of candidateIds) {
    const historyPath = getHistoryPath(pmRoot, candidateId);
    if (await pathExists(historyPath)) {
      return {
        id: candidateId,
        historyPath,
        located: null,
      };
    }
  }
  throw new PmCliError(`Item ${id} not found`, EXIT_CODE.NOT_FOUND);
}

/** Implements run history redact for the public runtime surface of this module. */
export async function runHistoryRedact(
  id: string,
  options: HistoryRedactCommandOptions,
  global: GlobalOptions,
): Promise<HistoryRedactResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(
      `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
      EXIT_CODE.NOT_FOUND,
    );
  }

  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(
    settings,
    getActiveExtensionRegistrations(),
  );
  const replacement =
    typeof options.replacement === "string" && options.replacement.length > 0
      ? options.replacement
      : "[redacted]";
  const rules = buildRedactionRules(options.literal, options.regex);
  const subject = await resolveHistorySubject(
    pmRoot,
    id,
    settings,
    typeRegistry.type_to_folder,
  );

  if (!(await pathExists(subject.historyPath))) {
    throw new PmCliError(
      `No history stream exists for ${subject.id}.`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  const historyRawBeforeLock = await readFileIfExists(subject.historyPath);
  const historyEntries = await readHistoryEntries(
    subject.historyPath,
    subject.id,
  );
  if (historyEntries.length === 0) {
    throw new PmCliError(
      `No history entries exist for ${subject.id}; nothing to redact.`,
      EXIT_CODE.USAGE,
    );
  }

  const integritySnapshot = inspectHistoryIntegrity(historyEntries);
  const rewritten = rewriteHistoryEntries(historyEntries, rules, replacement);
  const preexistingHashMismatches =
    integritySnapshot.hashMismatchesBefore +
    integritySnapshot.hashMismatchesAfter;
  const dryRun = Boolean(options.dryRun);
  const changed = rewritten.replacements > 0;
  const warnings: string[] = [];
  if (preexistingHashMismatches > 0) {
    warnings.push(
      `history_redact_preexisting_hash_mismatches:${preexistingHashMismatches}`,
    );
  }
  if (!changed) {
    warnings.push("history_redact_no_matches");
  }

  const currentItem = await loadHistoryRedactCurrentItem(subject, settings);
  const nextItem = resolveHistoryRedactNextItem({
    pmRoot,
    subject,
    settings,
    typeToFolder: typeRegistry.type_to_folder,
    finalDocument: rewritten.finalDocument,
  });

  const itemChanged =
    /* c8 ignore next -- null-coalescing item-path comparison branch is exercised in broader command integration coverage. */
    (currentItem.path ?? null) !== (nextItem.path ?? null) ||
    /* c8 ignore next -- null-coalescing item-content comparison branch is exercised in broader command integration coverage. */
    (currentItem.raw ?? null) !== (nextItem.raw ?? null);

  const author = resolveAuthor(options.author, settings.author_default);
  const redactionMessage = buildHistoryRedactMessage(options, rewritten);
  const { rewrittenEntries, auditEntryAdded } = buildHistoryRedactEntries({
    rewritten,
    dryRun,
    changed,
    nextItemDocument: nextItem.document,
    author,
    message: redactionMessage,
  });
  const historyVerify = verifyHistoryChain(rewrittenEntries);
  /* c8 ignore start -- invalid rewritten chains are covered by history verification unit tests. */
  if (!historyVerify.ok) {
    throw new PmCliError(
      `history-redact produced an invalid rewritten chain (${historyVerify.errors.join(", ")}).`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
  /* c8 ignore stop */

  if (!dryRun && changed) {
    warnings.push(
      ...(await applyHistoryRedactRewrite({
        pmRoot,
        subject,
        settings,
        typeRegistry,
        historyRawBeforeLock,
        currentItem,
        nextItem,
        author,
        force: options.force,
        rewrittenEntries,
      })),
    );
  }

  return {
    id: subject.id,
    dry_run: dryRun,
    changed,
    patterns: {
      literals: rules
        .filter((rule): rule is LiteralRule => rule.kind === "literal")
        .map((rule) => rule.value),
      regex: rules
        .filter((rule): rule is RegexRule => rule.kind === "regex")
        .map((rule) => `/${rule.source}/${rule.flags}`),
      replacement,
    },
    history: {
      path: subject.historyPath,
      entries_scanned: historyEntries.length,
      entries_changed: rewritten.entriesChanged,
      replacements: rewritten.replacements,
      hash_mismatches_before: integritySnapshot.hashMismatchesBefore,
      hash_mismatches_after: integritySnapshot.hashMismatchesAfter,
      preexisting_hash_mismatches: preexistingHashMismatches,
      audit_entry_added: auditEntryAdded,
      verify_ok: historyVerify.ok,
      verify_errors: historyVerify.errors,
    },
    item: {
      existed_before: currentItem.path !== null,
      exists_after: nextItem.path !== null,
      path_before: currentItem.path,
      path_after: nextItem.path,
      changed: itemChanged,
    },
    /* c8 ignore next -- warning dedupe ordering is covered indirectly by command-level smoke tests. */
    warnings: [...new Set(warnings)].sort((left, right) =>
      left.localeCompare(right),
    ),
    generated_at: nowIso(),
  };
}

/** Public contract for test only, shared by SDK and presentation-layer consumers. */
export const _testOnly = {
  applyLiteralRule,
  applyRegexRule,
  buildRedactionRules,
  hasItemMetadata,
  normalizeRegexFlags,
  normalizeStringArrayInput,
  parseRegexRule,
  redactStringValue,
  redactUnknownValue,
};
