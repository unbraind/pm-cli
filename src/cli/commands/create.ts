import { pathExists, removeFileIfExists, writeFileAtomic } from "../../core/fs/fs-utils.js";
import { appendHistoryEntry, createHistoryEntry } from "../../core/history/history.js";
import { generateItemId, normalizeItemId } from "../../core/item/id.js";
import { canonicalDocument, normalizeFrontMatter, serializeItemDocument } from "../../core/item/item-format.js";
import { parseCsvKv, parseOptionalNumber, parseTags } from "../../core/item/parse.js";
import { acquireLock } from "../../core/lock/lock.js";
import { EXIT_CODE, FRONT_MATTER_KEY_ORDER } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { isNoneToken, nowIso, resolveIsoOrRelative } from "../../core/shared/time.js";
import { runActiveOnWriteHooks } from "../../core/extensions/index.js";
import { getHistoryPath, getItemPath, getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type {
  Comment,
  Dependency,
  ItemDocument,
  ItemFrontMatter,
  LinkedDoc,
  LinkedFile,
  LinkedTest,
  LogNote,
} from "../../types/index.js";
import {
  CONFIDENCE_TEXT_VALUES,
  DEPENDENCY_KIND_VALUES,
  ITEM_TYPE_VALUES,
  RISK_VALUES,
  SCOPE_VALUES,
  STATUS_VALUES,
} from "../../types/index.js";

export interface CreateCommandOptions {
  title: string;
  description: string;
  type: string;
  status: string;
  priority: string;
  tags: string;
  body: string;
  deadline: string;
  estimatedMinutes: string;
  acceptanceCriteria: string;
  definitionOfReady?: string;
  order?: string;
  rank?: string;
  goal?: string;
  objective?: string;
  value?: string;
  impact?: string;
  outcome?: string;
  whyNow?: string;
  author: string;
  message: string;
  assignee: string;
  parent?: string;
  reviewer?: string;
  risk?: string;
  confidence?: string;
  sprint?: string;
  release?: string;
  blockedBy?: string;
  blockedReason?: string;
  dep?: string[];
  comment?: string[];
  note?: string[];
  learning?: string[];
  file?: string[];
  test?: string[];
  doc?: string[];
}

export interface CreateResult {
  item: ItemFrontMatter;
  changed_fields: string[];
  warnings: string[];
}

function ensureEnumValue<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if (!allowed.includes(value as T)) {
    throw new PmCliError(
      `Invalid ${label} value "${value}". Allowed: ${allowed.join(", ")}`,
      EXIT_CODE.USAGE,
    );
  }
  return value as T;
}

function normalizeRiskInput(value: string): string {
  const trimmed = value.trim();
  return trimmed.toLowerCase() === "med" ? "medium" : trimmed;
}

function parseConfidenceInput(value: string): number | "low" | "medium" | "high" {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "med") {
    return "medium";
  }
  if (CONFIDENCE_TEXT_VALUES.includes(trimmed as (typeof CONFIDENCE_TEXT_VALUES)[number])) {
    return trimmed as (typeof CONFIDENCE_TEXT_VALUES)[number];
  }
  const parsed = parseOptionalNumber(value, "confidence");
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
    throw new PmCliError("Confidence must be an integer 0..100 or one of low|med|medium|high", EXIT_CODE.USAGE);
  }
  return parsed;
}

function parseCreatedAt(value: string | undefined, currentIso: string): string {
  if (!value || value.trim() === "" || value.trim().toLowerCase() === "now") {
    return currentIso;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new PmCliError(`Invalid created_at timestamp "${value}"`, EXIT_CODE.USAGE);
  }
  return new Date(parsed).toISOString();
}

function parseOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (isNoneToken(value)) return undefined;
  return value;
}

function parseDependencies(
  raw: string[] | undefined,
  nowValue: string,
  prefix: string,
): { values: Dependency[] | undefined; explicitEmpty: boolean } {
  if (!raw || raw.length === 0) return { values: undefined, explicitEmpty: false };
  if (raw.some((entry) => isNoneToken(entry))) {
    if (raw.length > 1) {
      throw new PmCliError("--dep cannot mix 'none' with dependency values", EXIT_CODE.USAGE);
    }
    return { values: undefined, explicitEmpty: true };
  }
  const values: Dependency[] = raw.map((entry) => {
    const kv = parseCsvKv(entry, "--dep");
    const id = kv.id;
    const kind = kv.kind;
    if (!id || !kind) {
      throw new PmCliError("--dep requires id and kind", EXIT_CODE.USAGE);
    }
    return {
      id: normalizeItemId(id, prefix),
      kind: ensureEnumValue(kind, DEPENDENCY_KIND_VALUES, "dependency kind"),
      created_at: parseCreatedAt(kv.created_at, nowValue),
      author: parseOptionalString(kv.author),
    };
  });
  return { values, explicitEmpty: false };
}

function parseLogSeed(
  optionName: "--comment" | "--note" | "--learning",
  raw: string[] | undefined,
  nowValue: string,
  fallbackAuthor: string,
): { values: LogNote[] | Comment[] | undefined; explicitEmpty: boolean } {
  if (!raw || raw.length === 0) return { values: undefined, explicitEmpty: false };
  if (raw.some((entry) => isNoneToken(entry))) {
    if (raw.length > 1) {
      throw new PmCliError(`${optionName} cannot mix 'none' with seed values`, EXIT_CODE.USAGE);
    }
    return { values: undefined, explicitEmpty: true };
  }
  const values = raw.map((entry) => {
    const kv = parseCsvKv(entry, optionName);
    const text = kv.text ?? "";
    if (text === "") {
      throw new PmCliError(`${optionName} requires text=<value>`, EXIT_CODE.USAGE);
    }
    return {
      created_at: parseCreatedAt(kv.created_at, nowValue),
      author: parseOptionalString(kv.author) ?? fallbackAuthor,
      text,
    };
  });
  return { values, explicitEmpty: false };
}

function parseFiles(raw: string[] | undefined): { values: LinkedFile[] | undefined; explicitEmpty: boolean } {
  if (!raw || raw.length === 0) return { values: undefined, explicitEmpty: false };
  if (raw.some((entry) => isNoneToken(entry))) {
    if (raw.length > 1) {
      throw new PmCliError("--file cannot mix 'none' with file values", EXIT_CODE.USAGE);
    }
    return { values: undefined, explicitEmpty: true };
  }
  const values = raw.map((entry) => {
    const kv = parseCsvKv(entry, "--file");
    if (!kv.path) {
      throw new PmCliError("--file requires path=<value>", EXIT_CODE.USAGE);
    }
    return {
      path: kv.path,
      scope: ensureEnumValue(kv.scope ?? "project", SCOPE_VALUES, "file scope"),
      note: parseOptionalString(kv.note),
    };
  });
  return { values, explicitEmpty: false };
}

function parseTests(raw: string[] | undefined): { values: LinkedTest[] | undefined; explicitEmpty: boolean } {
  if (!raw || raw.length === 0) return { values: undefined, explicitEmpty: false };
  if (raw.some((entry) => isNoneToken(entry))) {
    if (raw.length > 1) {
      throw new PmCliError("--test cannot mix 'none' with test values", EXIT_CODE.USAGE);
    }
    return { values: undefined, explicitEmpty: true };
  }
  const values = raw.map((entry) => {
    const kv = parseCsvKv(entry, "--test");
    const command = parseOptionalString(kv.command);
    const filePath = parseOptionalString(kv.path);
    if (!command && !filePath) {
      throw new PmCliError("--test requires command=<value> and/or path=<value>", EXIT_CODE.USAGE);
    }
    const timeoutSecondsRaw = parseOptionalString(kv.timeout_seconds);
    const timeoutAliasRaw = parseOptionalString(kv.timeout);
    if (timeoutSecondsRaw && timeoutAliasRaw && timeoutSecondsRaw !== timeoutAliasRaw) {
      throw new PmCliError("--test timeout and timeout_seconds must match when both are provided", EXIT_CODE.USAGE);
    }
    const timeoutRaw = timeoutSecondsRaw ?? timeoutAliasRaw;
    return {
      command,
      path: filePath,
      scope: ensureEnumValue(kv.scope ?? "project", SCOPE_VALUES, "test scope"),
      timeout_seconds: timeoutRaw ? parseOptionalNumber(timeoutRaw, "timeout_seconds") : undefined,
      note: parseOptionalString(kv.note),
    };
  });
  return { values, explicitEmpty: false };
}

function parseDocs(raw: string[] | undefined): { values: LinkedDoc[] | undefined; explicitEmpty: boolean } {
  if (!raw || raw.length === 0) return { values: undefined, explicitEmpty: false };
  if (raw.some((entry) => isNoneToken(entry))) {
    if (raw.length > 1) {
      throw new PmCliError("--doc cannot mix 'none' with doc values", EXIT_CODE.USAGE);
    }
    return { values: undefined, explicitEmpty: true };
  }
  const values = raw.map((entry) => {
    const kv = parseCsvKv(entry, "--doc");
    if (!kv.path) {
      throw new PmCliError("--doc requires path=<value>", EXIT_CODE.USAGE);
    }
    return {
      path: kv.path,
      scope: ensureEnumValue(kv.scope ?? "project", SCOPE_VALUES, "doc scope"),
      note: parseOptionalString(kv.note),
    };
  });
  return { values, explicitEmpty: false };
}

function buildChangedFields(frontMatter: ItemFrontMatter, explicitUnsets: string[]): string[] {
  const changed = [
    ...FRONT_MATTER_KEY_ORDER.filter((key) => frontMatter[key] !== undefined),
    "body",
    ...explicitUnsets.map((key) => `unset:${key}`),
  ];
  return Array.from(new Set(changed));
}

function buildHistoryMessage(baseMessage: string | undefined, explicitUnsets: string[]): string | undefined {
  const trimmed = baseMessage ?? "";
  if (explicitUnsets.length === 0) {
    return trimmed;
  }
  const suffix = `explicit_unset=${explicitUnsets.join(",")}`;
  return trimmed ? `${trimmed} | ${suffix}` : suffix;
}

function selectAuthor(explicitAuthor: string | undefined, settingsAuthor: string): string {
  const candidate = parseOptionalString(explicitAuthor) ?? process.env.PM_AUTHOR ?? settingsAuthor;
  const trimmed = candidate.trim();
  return trimmed || "unknown";
}

function ensurePriority(rawPriority: string): 0 | 1 | 2 | 3 | 4 {
  const parsed = parseOptionalNumber(rawPriority, "priority");
  if (![0, 1, 2, 3, 4].includes(parsed)) {
    throw new PmCliError("Priority must be one of 0, 1, 2, 3, or 4", EXIT_CODE.USAGE);
  }
  return parsed as 0 | 1 | 2 | 3 | 4;
}

function ensureInitHasRun(pmRoot: string): Promise<void> {
  return pathExists(getSettingsPath(pmRoot)).then((exists) => {
    if (!exists) {
      throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
    }
  });
}

export async function runCreate(options: CreateCommandOptions, global: GlobalOptions): Promise<CreateResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await ensureInitHasRun(pmRoot);

  const settings = await readSettings(pmRoot);
  const nowValue = nowIso();
  const author = selectAuthor(options.author, settings.author_default);
  const explicitUnsets: string[] = [];

  const dependencies = parseDependencies(options.dep, nowValue, settings.id_prefix);
  if (dependencies.explicitEmpty) explicitUnsets.push("dependencies");
  const comments = parseLogSeed("--comment", options.comment, nowValue, author);
  if (comments.explicitEmpty) explicitUnsets.push("comments");
  const notes = parseLogSeed("--note", options.note, nowValue, author);
  if (notes.explicitEmpty) explicitUnsets.push("notes");
  const learnings = parseLogSeed("--learning", options.learning, nowValue, author);
  if (learnings.explicitEmpty) explicitUnsets.push("learnings");
  const files = parseFiles(options.file);
  if (files.explicitEmpty) explicitUnsets.push("files");
  const tests = parseTests(options.test);
  if (tests.explicitEmpty) explicitUnsets.push("tests");
  const docs = parseDocs(options.doc);
  if (docs.explicitEmpty) explicitUnsets.push("docs");

  const scalarExplicitUnsetCandidates: ReadonlyArray<readonly [string | undefined, string]> = [
    [options.deadline, "deadline"],
    [options.estimatedMinutes, "estimated_minutes"],
    [options.acceptanceCriteria, "acceptance_criteria"],
    [options.definitionOfReady, "definition_of_ready"],
    [options.order, "order"],
    [options.rank, "order"],
    [options.goal, "goal"],
    [options.objective, "objective"],
    [options.value, "value"],
    [options.impact, "impact"],
    [options.outcome, "outcome"],
    [options.whyNow, "why_now"],
    [options.assignee, "assignee"],
    [options.author, "author"],
    [options.parent, "parent"],
    [options.reviewer, "reviewer"],
    [options.risk, "risk"],
    [options.confidence, "confidence"],
    [options.sprint, "sprint"],
    [options.release, "release"],
    [options.blockedBy, "blocked_by"],
    [options.blockedReason, "blocked_reason"],
  ];
  for (const [value, key] of scalarExplicitUnsetCandidates) {
    if (isNoneToken(value)) {
      explicitUnsets.push(key);
    }
  }

  const id = await generateItemId(pmRoot, settings.id_prefix);
  const type = ensureEnumValue(options.type, ITEM_TYPE_VALUES, "type");
  const status = ensureEnumValue(options.status, STATUS_VALUES, "status");
  const priority = ensurePriority(options.priority);
  const tags = parseTags(options.tags);

  const deadline = isNoneToken(options.deadline) ? undefined : resolveIsoOrRelative(options.deadline, new Date(nowValue));
  const estimatedMinutes = isNoneToken(options.estimatedMinutes)
    ? undefined
    : parseOptionalNumber(options.estimatedMinutes, "estimated-minutes");
  const acceptanceCriteria = isNoneToken(options.acceptanceCriteria) ? undefined : options.acceptanceCriteria;
  const definitionOfReady = options.definitionOfReady !== undefined ? parseOptionalString(options.definitionOfReady) : undefined;
  if (options.order !== undefined && options.rank !== undefined && options.order !== options.rank) {
    throw new PmCliError("--order and --rank must match when both are provided", EXIT_CODE.USAGE);
  }
  const orderRaw = options.order ?? options.rank;
  const order = orderRaw === undefined || isNoneToken(orderRaw) ? undefined : parseOptionalNumber(orderRaw, "order");
  if (order !== undefined && !Number.isInteger(order)) {
    throw new PmCliError("Order must be an integer", EXIT_CODE.USAGE);
  }
  const goal = options.goal !== undefined ? parseOptionalString(options.goal) : undefined;
  const objective = options.objective !== undefined ? parseOptionalString(options.objective) : undefined;
  const value = options.value !== undefined ? parseOptionalString(options.value) : undefined;
  const impact = options.impact !== undefined ? parseOptionalString(options.impact) : undefined;
  const outcome = options.outcome !== undefined ? parseOptionalString(options.outcome) : undefined;
  const whyNow = options.whyNow !== undefined ? parseOptionalString(options.whyNow) : undefined;
  const assignee = parseOptionalString(options.assignee);
  const authorValue = parseOptionalString(options.author) ?? author;
  const parent = options.parent !== undefined ? parseOptionalString(options.parent) : undefined;
  const reviewer = options.reviewer !== undefined ? parseOptionalString(options.reviewer) : undefined;
  const riskRaw = options.risk !== undefined ? parseOptionalString(options.risk) : undefined;
  const risk = riskRaw !== undefined ? ensureEnumValue(normalizeRiskInput(riskRaw), RISK_VALUES, "risk") : undefined;
  const confidenceRaw = options.confidence !== undefined ? parseOptionalString(options.confidence) : undefined;
  const confidence = confidenceRaw !== undefined ? parseConfidenceInput(confidenceRaw) : undefined;
  const sprint = options.sprint !== undefined ? parseOptionalString(options.sprint) : undefined;
  const release = options.release !== undefined ? parseOptionalString(options.release) : undefined;
  const blockedBy = options.blockedBy !== undefined ? parseOptionalString(options.blockedBy) : undefined;
  const blockedReason = options.blockedReason !== undefined ? parseOptionalString(options.blockedReason) : undefined;

  const frontMatter: ItemFrontMatter = normalizeFrontMatter({
    id,
    title: options.title,
    description: options.description,
    type,
    status,
    priority,
    tags,
    created_at: nowValue,
    updated_at: nowValue,
    deadline,
    assignee,
    author: authorValue,
    estimated_minutes: estimatedMinutes,
    acceptance_criteria: acceptanceCriteria,
    definition_of_ready: definitionOfReady,
    order,
    goal,
    objective,
    value,
    impact,
    outcome,
    why_now: whyNow,
    parent,
    reviewer,
    risk,
    confidence,
    sprint,
    release,
    blocked_by: blockedBy,
    blocked_reason: blockedReason,
    dependencies: dependencies.values,
    comments: comments.values as Comment[] | undefined,
    notes: notes.values as LogNote[] | undefined,
    learnings: learnings.values as LogNote[] | undefined,
    files: files.values,
    tests: tests.values,
    docs: docs.values,
  });

  const afterDocument: ItemDocument = canonicalDocument({
    front_matter: frontMatter,
    body: options.body,
  });
  const beforeDocument: ItemDocument = {
    front_matter: {} as ItemFrontMatter,
    body: "",
  };

  const itemPath = getItemPath(pmRoot, type, id);
  const historyPath = getHistoryPath(pmRoot, id);
  const lockRelease = await acquireLock(pmRoot, id, settings.locks.ttl_seconds, author);
  const historyMessage = buildHistoryMessage(options.message, explicitUnsets);
  let hookWarnings: string[] = [];

  try {
    await writeFileAtomic(itemPath, serializeItemDocument(afterDocument));
    try {
      const entry = createHistoryEntry({
        nowIso: nowValue,
        author,
        op: "create",
        before: beforeDocument,
        after: afterDocument,
        message: historyMessage,
      });
      await appendHistoryEntry(historyPath, entry);
    } catch (error: unknown) {
      await removeFileIfExists(itemPath);
      throw error;
    }
    hookWarnings = [
      ...(await runActiveOnWriteHooks({
        path: itemPath,
        scope: "project",
        op: "create",
      })),
      ...(await runActiveOnWriteHooks({
        path: historyPath,
        scope: "project",
        op: "create:history",
      })),
    ];
  } finally {
    await lockRelease();
  }

  const changedFields = buildChangedFields(frontMatter, explicitUnsets);
  const outputItem = structuredClone(frontMatter);
  return {
    item: outputItem,
    changed_fields: changedFields,
    warnings: hookWarnings,
  };
}
