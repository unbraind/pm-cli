/**
 * @module sdk/templates
 *
 * Implements the pm templates command surface and its agent-facing runtime behavior.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  pathExists,
  readFileIfExists,
  writeFileAtomic,
} from "../core/fs/fs-utils.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import type { GlobalOptions } from "../core/shared/command-types.js";
import { PmCliError } from "../core/shared/errors.js";
import { nowIso } from "../core/shared/time.js";
import { getSettingsPath, resolvePmRoot } from "../core/store/paths.js";
import { CREATE_COMMANDER_REPEATABLE_OPTION_CONTRACTS } from "./cli-contracts.js";

const TEMPLATE_DIRECTORY_NAME = "templates";
const TEMPLATE_FILE_EXTENSION = ".json";
const TEMPLATE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const TEMPLATE_OPTION_REPEATABLE_KEYS =
  CREATE_COMMANDER_REPEATABLE_OPTION_CONTRACTS.map(
    (entry) => entry.target,
  ).filter((target) => target !== "acceptanceCriteria");
const TEMPLATE_OPTION_REPEATABLE_KEY_SET = new Set<string>(
  TEMPLATE_OPTION_REPEATABLE_KEYS,
);

type TemplateOptionValue = string | string[];
/** Restricts create template options values accepted by command, SDK, and storage contracts. */
export type CreateTemplateOptions = Record<string, TemplateOptionValue>;
/** Restricts template source values accepted by command, SDK, and storage contracts. */
export type TemplateSource = "builtin" | "user";

const BUILTIN_TEMPLATE_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const BUILTIN_TEMPLATES: Readonly<Record<string, CreateTemplateOptions>> = {
  bug: {
    type: "Issue",
    priority: "1",
    tags: "bug",
    acceptanceCriteria:
      "Bug no longer reproduces with the steps below and a regression test guards it.",
    expectedResult: "Describe the correct behavior.",
    actualResult: "Describe the observed (buggy) behavior.",
    body: "## Repro steps\n1. \n2. \n3. \n\n## Expected\n\n## Actual\n",
  },
  feature: {
    type: "Feature",
    priority: "2",
    tags: "feature",
    acceptanceCriteria:
      "Feature is shipped behind agreed scope with tests and docs updated.",
    whyNow: "Explain why this is worth doing now (impact / urgency).",
    body: "## Goal\n\n## Why now\n\n## Out of scope\n",
  },
  spike: {
    type: "Task",
    priority: "2",
    tags: "spike",
    estimatedMinutes: "120",
    acceptanceCriteria:
      "Timeboxed investigation complete; findings and a recommendation are recorded.",
    body: "## Question to answer\n\n## Timebox\n2h\n\n## Findings\n\n## Recommendation\n",
  },
  chore: {
    type: "Chore",
    priority: "3",
    tags: "chore",
    acceptanceCriteria:
      "Maintenance task done with no behavior change and green checks.",
    body: "## What\n\n## Why\n",
  },
};

interface StoredCreateTemplateDocument {
  name: string;
  created_at: string;
  updated_at: string;
  options: CreateTemplateOptions;
}

/** Public contract for test only, shared by SDK and presentation-layer consumers. */
export const _testOnly = {
  normalizeTemplateName,
  extractTemplateOptions,
  parseStoredTemplateDocument,
  builtinTemplateDocument,
  readStoredTemplateDocument,
};

/** Documents the templates save result payload exchanged by command, SDK, and package integrations. */
export interface TemplatesSaveResult {
  /** Value that configures or reports name for this contract. */
  name: string;
  /** ISO 8601 timestamp recording when created occurred. */
  created_at: string;
  /** ISO 8601 timestamp recording when updated occurred. */
  updated_at: string;
  /** Filesystem path used for path resolution. */
  path: string;
  /** Value that configures or reports options for this contract. */
  options: CreateTemplateOptions;
}

/** Documents the templates list result payload exchanged by command, SDK, and package integrations. */
export interface TemplatesListResult {
  /** Value that configures or reports templates for this contract. */
  templates: string[];
  /** Value that configures or reports count for this contract. */
  count: number;
  /** Value that configures or reports builtin templates for this contract. */
  builtin_templates: string[];
  /** Value that configures or reports user templates for this contract. */
  user_templates: string[];
}

/** Documents the templates show result payload exchanged by command, SDK, and package integrations. */
export interface TemplatesShowResult {
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Value that configures or reports source for this contract. */
  source: TemplateSource;
  /** ISO 8601 timestamp recording when created occurred. */
  created_at: string;
  /** ISO 8601 timestamp recording when updated occurred. */
  updated_at: string;
  /** Filesystem path used for path resolution. */
  path: string;
  /** Value that configures or reports options for this contract. */
  options: CreateTemplateOptions;
}

function normalizeTemplateName(rawName: string): string {
  const name = rawName.trim();
  if (!TEMPLATE_NAME_PATTERN.test(name)) {
    throw new PmCliError(
      `Invalid template name "${rawName}". Expected 1-64 characters matching [A-Za-z0-9][A-Za-z0-9._-]*.`,
      EXIT_CODE.USAGE,
    );
  }
  return name;
}

function templatesDirectory(pmRoot: string): string {
  return path.join(pmRoot, TEMPLATE_DIRECTORY_NAME);
}

function templatePath(pmRoot: string, normalizedName: string): string {
  return path.join(
    templatesDirectory(pmRoot),
    `${normalizedName}${TEMPLATE_FILE_EXTENSION}`,
  );
}

async function ensureTrackerInitialized(pmRoot: string): Promise<void> {
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(
      `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
      EXIT_CODE.NOT_FOUND,
    );
  }
}

function sortTemplateOptions(
  options: CreateTemplateOptions,
): CreateTemplateOptions {
  return Object.fromEntries(
    Object.entries(options).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  ) as CreateTemplateOptions;
}

function extractTemplateOptions(
  rawOptions: Record<string, unknown>,
): CreateTemplateOptions {
  const next: CreateTemplateOptions = {};
  for (const [key, value] of Object.entries(rawOptions)) {
    if (value === undefined) {
      continue;
    }
    if (TEMPLATE_OPTION_REPEATABLE_KEY_SET.has(key)) {
      if (typeof value === "string") {
        next[key] = [value];
        continue;
      }
      if (!Array.isArray(value)) {
        continue;
      }
      const values = value.filter(
        (entry): entry is string => typeof entry === "string",
      );
      if (values.length > 0) {
        next[key] = values;
      }
      continue;
    }
    if (typeof value === "string") {
      next[key] = value;
      continue;
    }
    if (
      Array.isArray(value) &&
      value.every((entry) => typeof entry === "string")
    ) {
      next[key] = [...value];
    }
  }
  return sortTemplateOptions(next);
}

function parseStoredTemplateOptions(
  rawOptions: unknown,
  templateName: string,
): CreateTemplateOptions {
  if (
    typeof rawOptions !== "object" ||
    rawOptions === null ||
    Array.isArray(rawOptions)
  ) {
    throw new PmCliError(
      `Template "${templateName}" has invalid options payload.`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
  const optionsRecord = rawOptions as Record<string, unknown>;
  const normalized: CreateTemplateOptions = {};
  for (const [key, value] of Object.entries(optionsRecord)) {
    const normalizedKey = key.trim();
    if (normalizedKey.length === 0) {
      throw new PmCliError(
        `Template "${templateName}" contains an empty option key.`,
        EXIT_CODE.GENERIC_FAILURE,
      );
    }
    if (typeof value === "string") {
      normalized[normalizedKey] = value;
      continue;
    }
    if (
      Array.isArray(value) &&
      value.every((entry) => typeof entry === "string")
    ) {
      normalized[normalizedKey] = [...value];
      continue;
    }
    throw new PmCliError(
      `Template "${templateName}" contains invalid value for option "${normalizedKey}".`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
  return sortTemplateOptions(normalized);
}

function parseStoredTemplateDocument(
  raw: string,
  normalizedName: string,
): StoredCreateTemplateDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new PmCliError(
      `Template "${normalizedName}" contains invalid JSON.`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PmCliError(
      `Template "${normalizedName}" has invalid document shape.`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
  const record = parsed as Record<string, unknown>;
  const options = parseStoredTemplateOptions(record.options, normalizedName);
  const now = nowIso();
  return {
    name:
      typeof record.name === "string" && record.name.trim().length > 0
        ? record.name.trim()
        : normalizedName,
    created_at: typeof record.created_at === "string" ? record.created_at : now,
    updated_at: typeof record.updated_at === "string" ? record.updated_at : now,
    options,
  };
}

function builtinTemplateDocument(
  normalizedName: string,
): StoredCreateTemplateDocument | null {
  const options = BUILTIN_TEMPLATES[normalizedName];
  if (!options) {
    return null;
  }
  return {
    name: normalizedName,
    created_at: BUILTIN_TEMPLATE_TIMESTAMP,
    updated_at: BUILTIN_TEMPLATE_TIMESTAMP,
    options: sortTemplateOptions({ ...options }),
  };
}

interface ResolvedTemplateDocument {
  document: StoredCreateTemplateDocument;
  source: TemplateSource;
}

async function resolveTemplateDocument(
  pmRoot: string,
  normalizedName: string,
): Promise<ResolvedTemplateDocument> {
  const raw = await readFileIfExists(templatePath(pmRoot, normalizedName));
  if (raw !== null) {
    return {
      document: parseStoredTemplateDocument(raw, normalizedName),
      source: "user",
    };
  }
  const builtin = builtinTemplateDocument(normalizedName);
  if (builtin) {
    return { document: builtin, source: "builtin" };
  }
  throw new PmCliError(
    `Template "${normalizedName}" not found`,
    EXIT_CODE.NOT_FOUND,
  );
}

async function readStoredTemplateDocument(
  pmRoot: string,
  normalizedName: string,
): Promise<StoredCreateTemplateDocument> {
  const raw = await readFileIfExists(templatePath(pmRoot, normalizedName));
  if (raw === null) {
    throw new PmCliError(
      `Template "${normalizedName}" not found`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  return parseStoredTemplateDocument(raw, normalizedName);
}

/** Implements load create template options for the public runtime surface of this module. */
export async function loadCreateTemplateOptions(
  pmRoot: string,
  rawTemplateName: string,
): Promise<CreateTemplateOptions> {
  const normalizedName = normalizeTemplateName(rawTemplateName);
  const { document } = await resolveTemplateDocument(pmRoot, normalizedName);
  return document.options;
}

/** Implements run templates save for the public runtime surface of this module. */
export async function runTemplatesSave(
  rawTemplateName: string,
  options: Record<string, unknown>,
  global: GlobalOptions,
): Promise<TemplatesSaveResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await ensureTrackerInitialized(pmRoot);
  const normalizedName = normalizeTemplateName(rawTemplateName);
  const nextOptions = extractTemplateOptions(options);
  if (Object.keys(nextOptions).length === 0) {
    throw new PmCliError(
      "templates save requires at least one create option flag",
      EXIT_CODE.USAGE,
    );
  }

  const now = nowIso();
  const storedPath = templatePath(pmRoot, normalizedName);
  let createdAt = now;
  if (await pathExists(storedPath)) {
    const existing = await readStoredTemplateDocument(pmRoot, normalizedName);
    createdAt = existing.created_at;
  }

  const document: StoredCreateTemplateDocument = {
    name: normalizedName,
    created_at: createdAt,
    updated_at: now,
    options: nextOptions,
  };
  await fs.mkdir(templatesDirectory(pmRoot), { recursive: true });
  await writeFileAtomic(storedPath, `${JSON.stringify(document, null, 2)}\n`);
  return {
    name: document.name,
    created_at: document.created_at,
    updated_at: document.updated_at,
    path: storedPath,
    options: document.options,
  };
}

async function readUserTemplateNames(pmRoot: string): Promise<string[]> {
  const dirPath = templatesDirectory(pmRoot);
  if (!(await pathExists(dirPath))) {
    return [];
  }
  const entries = await fs.readdir(dirPath);
  return entries
    .filter((entry) => entry.toLowerCase().endsWith(TEMPLATE_FILE_EXTENSION))
    .map((entry) => entry.slice(0, -TEMPLATE_FILE_EXTENSION.length))
    .filter((entry) => TEMPLATE_NAME_PATTERN.test(entry));
}

/** Implements run templates list for the public runtime surface of this module. */
export async function runTemplatesList(
  global: GlobalOptions,
): Promise<TemplatesListResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await ensureTrackerInitialized(pmRoot);
  const userTemplates = await readUserTemplateNames(pmRoot);
  const userTemplateSet = new Set<string>(userTemplates);
  const builtinTemplates = Object.keys(BUILTIN_TEMPLATES).filter(
    (name) => !userTemplateSet.has(name),
  );
  const sortedUser = [...userTemplates].sort((left, right) =>
    left.localeCompare(right),
  );
  const sortedBuiltin = [...builtinTemplates].sort((left, right) =>
    left.localeCompare(right),
  );
  const templates = [...new Set([...sortedUser, ...sortedBuiltin])].sort(
    (left, right) => left.localeCompare(right),
  );
  return {
    templates,
    count: templates.length,
    builtin_templates: sortedBuiltin,
    user_templates: sortedUser,
  };
}

/** Implements run templates show for the public runtime surface of this module. */
export async function runTemplatesShow(
  rawTemplateName: string,
  global: GlobalOptions,
): Promise<TemplatesShowResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await ensureTrackerInitialized(pmRoot);
  const normalizedName = normalizeTemplateName(rawTemplateName);
  const { document, source } = await resolveTemplateDocument(
    pmRoot,
    normalizedName,
  );
  return {
    name: document.name,
    source,
    created_at: document.created_at,
    updated_at: document.updated_at,
    path:
      source === "builtin"
        ? `builtin:${normalizedName}`
        : templatePath(pmRoot, normalizedName),
    options: document.options,
  };
}
