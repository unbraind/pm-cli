/**
 * Static GitHub workflow evidence for repository-owned recurrence check names.
 * Tracker: pm-7c27ep. Runtime expressions are never evaluated or certified.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseDocument } from "yaml";

/** Distinguish workflow mappings from scalar, null, and sequence YAML nodes. */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read every workflow once, preserving stable job IDs and authored names. */
export async function readWorkflowDefinitions(workflowsRoot) {
  const files = (await readdir(workflowsRoot))
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .sort();
  const definitions = [];
  for (const file of files) {
    const document = parseDocument(await readFile(path.join(workflowsRoot, file), "utf8"));
    if (document.errors.length > 0) {
      throw new Error(`Invalid workflow YAML ${file}: ${document.errors.map((error) => error.message).join("; ")}`);
    }
    const workflow = document.toJS();
    definitions.push({
      file,
      name: typeof workflow?.name === "string" ? workflow.name : `.github/workflows/${file}`,
      jobs: isRecord(workflow?.jobs) ? workflow.jobs : {},
    });
  }
  return definitions;
}

/**
 * Expand bounded static axes, then exclude and include against original rows.
 * Include-only matrices retain separate rows. Unsupported dynamic declarations
 * and expansions beyond 256 combinations cannot certify a required check name.
 */
export function expandWorkflowMatrix(matrix) {
  if (matrix === undefined) return [{}];
  if (!isRecord(matrix)) return [];
  const includes = matrix.include === undefined ? [] : matrix.include;
  const excludes = matrix.exclude === undefined ? [] : matrix.exclude;
  if (![includes, excludes].every((entries) => Array.isArray(entries) && entries.every(isRecord))) return [];
  const axes = Object.entries(matrix).filter(([key]) => key !== "include" && key !== "exclude");
  let originals = axes.length === 0 ? [] : [{}];
  for (const [key, values] of axes) {
    if (!Array.isArray(values) || originals.length * values.length > 256) return [];
    originals = originals.flatMap((row) => values.map((value) => ({ ...row, [key]: value })));
  }
  originals = originals.filter((row) => !excludes.some((excluded) =>
    Object.entries(excluded).every(([key, value]) => Object.hasOwn(row, key) && isDeepStrictEqual(row[key], value))));
  return applyMatrixIncludes(originals, includes);
}

/** Merge includes against original rows so later includes cannot alter original axis values. */
function applyMatrixIncludes(originals, includes) {
  const expanded = originals.map((row) => ({ ...row }));
  for (const included of includes) {
    let matched = false;
    for (const [index, original] of originals.entries()) {
      if (!Object.entries(included).every(([key, value]) => !Object.hasOwn(original, key) || isDeepStrictEqual(original[key], value))) continue;
      expanded[index] = { ...expanded[index], ...included };
      matched = true;
    }
    if (!matched) expanded.push({ ...included });
  }
  return expanded.length > 256 ? [] : expanded;
}

/** Resolve only literal matrix property expressions; other expressions stay unresolved. */
function renderJobName(template, row) {
  return template.replace(/\$\{\{\s*matrix\.([\w.-]+)\s*\}\}/gu, (expression, field) => {
    const value = field.split(".").reduce((current, key) =>
      isRecord(current) && Object.hasOwn(current, key) ? current[key] : undefined, row);
    return ["string", "number", "boolean"].includes(typeof value) ? String(value) : expression;
  });
}

/** Collect one workflow's resolvable names, leaving dynamic and unnamed matrix jobs uncertified. */
function workflowCheckNames(workflow) {
  const names = [];
  for (const [id, job] of Object.entries(workflow.jobs)) {
    if (!isRecord(job)) continue;
    const matrix = job.strategy?.matrix;
    if (matrix !== undefined && typeof job.name !== "string") continue;
    const template = typeof job.name === "string" ? job.name : id;
    for (const row of expandWorkflowMatrix(matrix)) {
      const name = `${workflow.name} / ${renderJobName(template, row)}`;
      if (!name.includes("${{")) names.push(name);
    }
  }
  return names;
}

/** Derive concrete workflow/job names without treating unresolved templates as evidence. */
export async function discoverWorkflowCheckNames(workflowsRoot) {
  const definitions = await readWorkflowDefinitions(workflowsRoot);
  return [...new Set(definitions.flatMap(workflowCheckNames))].sort();
}
