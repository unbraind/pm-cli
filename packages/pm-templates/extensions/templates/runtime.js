import fs from "node:fs/promises";
import path from "node:path";
import {
  CREATE_COMMANDER_REPEATABLE_OPTION_CONTRACTS,
  EXIT_CODE,
  PmCliError,
  getSettingsPath,
  nowIso,
  pathExists,
  readFileIfExists,
  resolvePmRoot,
  writeFileAtomic,
} from "../../../../dist/sdk/index.js";

const TEMPLATE_DIRECTORY_NAME = "templates";
const TEMPLATE_FILE_EXTENSION = ".json";
const TEMPLATE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TEMPLATE_OPTION_REPEATABLE_KEY_SET = new Set(CREATE_COMMANDER_REPEATABLE_OPTION_CONTRACTS.map((entry) => entry.target));

function normalizeTemplateName(rawName) {
  const name = rawName.trim();
  if (!TEMPLATE_NAME_PATTERN.test(name)) {
    throw new PmCliError(
      `Invalid template name "${rawName}". Expected 1-64 characters matching [A-Za-z0-9][A-Za-z0-9._-]*.`,
      EXIT_CODE.USAGE,
    );
  }
  return name;
}

function templatesDirectory(pmRoot) {
  return path.join(pmRoot, TEMPLATE_DIRECTORY_NAME);
}

function templatePath(pmRoot, normalizedName) {
  return path.join(templatesDirectory(pmRoot), `${normalizedName}${TEMPLATE_FILE_EXTENSION}`);
}

async function ensureTrackerInitialized(pmRoot) {
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
}

function sortTemplateOptions(options) {
  return Object.fromEntries(Object.entries(options).sort(([left], [right]) => left.localeCompare(right)));
}

function extractTemplateOptions(rawOptions) {
  const next = {};
  for (const [key, value] of Object.entries(rawOptions)) {
    if (value === undefined) {
      continue;
    }
    if (TEMPLATE_OPTION_REPEATABLE_KEY_SET.has(key)) {
      if (!Array.isArray(value)) {
        continue;
      }
      const values = value.filter((entry) => typeof entry === "string");
      if (values.length > 0) {
        next[key] = values;
      }
      continue;
    }
    if (typeof value === "string") {
      next[key] = value;
      continue;
    }
    if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
      next[key] = [...value];
    }
  }
  return sortTemplateOptions(next);
}

function parseStoredTemplateOptions(rawOptions, templateName) {
  if (typeof rawOptions !== "object" || rawOptions === null || Array.isArray(rawOptions)) {
    throw new PmCliError(`Template "${templateName}" has invalid options payload.`, EXIT_CODE.GENERIC_FAILURE);
  }
  const normalized = {};
  for (const [key, value] of Object.entries(rawOptions)) {
    const normalizedKey = key.trim();
    if (normalizedKey.length === 0) {
      throw new PmCliError(`Template "${templateName}" contains an empty option key.`, EXIT_CODE.GENERIC_FAILURE);
    }
    if (typeof value === "string") {
      normalized[normalizedKey] = value;
      continue;
    }
    if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
      normalized[normalizedKey] = [...value];
      continue;
    }
    throw new PmCliError(`Template "${templateName}" contains invalid value for option "${normalizedKey}".`, EXIT_CODE.GENERIC_FAILURE);
  }
  return sortTemplateOptions(normalized);
}

function parseStoredTemplateDocument(raw, normalizedName) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PmCliError(`Template "${normalizedName}" contains invalid JSON.`, EXIT_CODE.GENERIC_FAILURE);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PmCliError(`Template "${normalizedName}" has invalid document shape.`, EXIT_CODE.GENERIC_FAILURE);
  }
  const options = parseStoredTemplateOptions(parsed.options, normalizedName);
  const now = nowIso();
  return {
    name: typeof parsed.name === "string" && parsed.name.trim().length > 0 ? parsed.name.trim() : normalizedName,
    created_at: typeof parsed.created_at === "string" ? parsed.created_at : now,
    updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : now,
    options,
  };
}

async function readStoredTemplateDocument(pmRoot, normalizedName) {
  const raw = await readFileIfExists(templatePath(pmRoot, normalizedName));
  if (raw === null) {
    throw new PmCliError(`Template "${normalizedName}" not found`, EXIT_CODE.NOT_FOUND);
  }
  return parseStoredTemplateDocument(raw, normalizedName);
}

export async function runTemplatesSave(rawTemplateName, options, global) {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await ensureTrackerInitialized(pmRoot);
  const normalizedName = normalizeTemplateName(rawTemplateName);
  const nextOptions = extractTemplateOptions(options);
  if (Object.keys(nextOptions).length === 0) {
    throw new PmCliError("templates save requires at least one create option flag", EXIT_CODE.USAGE);
  }

  const now = nowIso();
  const storedPath = templatePath(pmRoot, normalizedName);
  let createdAt = now;
  if (await pathExists(storedPath)) {
    const existing = await readStoredTemplateDocument(pmRoot, normalizedName);
    createdAt = existing.created_at;
  }

  const document = {
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

export async function runTemplatesList(global) {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await ensureTrackerInitialized(pmRoot);
  const dirPath = templatesDirectory(pmRoot);
  if (!(await pathExists(dirPath))) {
    return { templates: [], count: 0 };
  }
  const entries = await fs.readdir(dirPath);
  const templates = entries
    .filter((entry) => entry.toLowerCase().endsWith(TEMPLATE_FILE_EXTENSION))
    .map((entry) => entry.slice(0, -TEMPLATE_FILE_EXTENSION.length))
    .filter((entry) => TEMPLATE_NAME_PATTERN.test(entry))
    .sort((left, right) => left.localeCompare(right));
  return {
    templates,
    count: templates.length,
  };
}

export async function runTemplatesShow(rawTemplateName, global) {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await ensureTrackerInitialized(pmRoot);
  const normalizedName = normalizeTemplateName(rawTemplateName);
  const stored = await readStoredTemplateDocument(pmRoot, normalizedName);
  return {
    name: stored.name,
    created_at: stored.created_at,
    updated_at: stored.updated_at,
    path: templatePath(pmRoot, normalizedName),
    options: stored.options,
  };
}
