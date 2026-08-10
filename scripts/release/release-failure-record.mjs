#!/usr/bin/env node
/**
 * @module release-failure-record
 *
 * Records and renders the structured failure document that lets the blocked
 * Auto Release alert name the cause a run actually produced.
 *
 * The blocker issue previously derived its cause from four preflight
 * environment booleans, so it could only name a missing secret and reported a
 * fixed "inspect the logs" string for every failure where the pipeline had in
 * fact run and a gate had returned a verdict. The verdict was on standard
 * output at the moment the runner raised, and was discarded.
 *
 * This module keeps that verdict. The gate runner writes a document naming the
 * failing gate, its exit status and its captured output; the workflow renders
 * the alert from the document. Classification reads structured fields only —
 * matching patterns against log or message prose is deliberately out of scope,
 * because this project has already ruled that enforcement reads contracts and
 * never prose.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Schema tag stored on every document so a reader can reject foreign shapes. */
export const RECORD_SCHEMA = "release-failure-record/1";

/** Captured gate output is bounded so an alert body stays within issue limits. */
export const MAX_CAPTURE_CHARS = 4000;

/** Blocking identifiers rendered into the one-line cause. */
export const MAX_RENDERED_BLOCKERS = 8;

function boundedText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length <= MAX_CAPTURE_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_CAPTURE_CHARS)}[truncated]`;
}

function trimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Write the failure document for a gate that exited non-zero.
 *
 * Returns the document when a target path was supplied, and null when the
 * environment declared none, so local gate runs stay side-effect free.
 */
export function recordGateFailure(failure, recordPath) {
  const target = trimmedString(recordPath ?? process.env.RELEASE_FAILURE_RECORD);
  if (target === "") {
    return null;
  }
  const document = {
    schema: RECORD_SCHEMA,
    stage: trimmedString(failure?.gate),
    status: Number.isInteger(failure?.status) ? failure.status : null,
    stdout: boundedText(failure?.stdout),
    stderr: boundedText(failure?.stderr),
  };
  mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return document;
}

/** Parse a gate's captured stdout as its JSON verdict, or null when it is not one. */
export function parseGateVerdict(stdout) {
  const text = trimmedString(stdout);
  if (text === "") {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function reasonsById(section) {
  const reasons = new Map();
  const rows = Array.isArray(section.blocking_reasons)
    ? section.blocking_reasons
    : [];
  for (const row of rows) {
    const id = trimmedString(row?.short_id);
    const reason = trimmedString(row?.reason);
    if (id !== "" && reason !== "") {
      reasons.set(id, reason);
    }
  }
  return reasons;
}

/**
 * Collect blocking identifiers from a gate verdict.
 *
 * Reads the declared `blocking_short_ids` and `blocking_reasons` fields of each
 * top-level verdict section. A verdict that declares neither yields nothing,
 * which is the safe degenerate case: the cause then names the gate alone.
 */
export function collectBlockingSummaries(verdict) {
  const summaries = [];
  for (const section of Object.values(verdict ?? {})) {
    if (section === null || typeof section !== "object") {
      continue;
    }
    const ids = Array.isArray(section.blocking_short_ids)
      ? section.blocking_short_ids
      : [];
    const reasons = reasonsById(section);
    for (const entry of ids) {
      const id = trimmedString(entry);
      if (id === "") {
        continue;
      }
      const reason = reasons.get(id);
      summaries.push(reason === undefined ? id : `${id} (${reason})`);
    }
  }
  return summaries;
}

/**
 * Describe a failure document as a stage plus a single-line cause.
 *
 * Returns null when the document names no stage, so the caller falls back to
 * the preflight configuration detection it already performs.
 */
export function describeFailureRecord(document) {
  if (trimmedString(document?.schema) !== RECORD_SCHEMA) {
    return null;
  }
  const stage = trimmedString(document?.stage);
  if (stage === "") {
    return null;
  }
  const status = Number.isInteger(document?.status) ? document.status : null;
  const exit = status === null ? "an unreported status" : `status ${status}`;
  const blockers = collectBlockingSummaries(parseGateVerdict(document?.stdout));
  const shown = blockers.slice(0, MAX_RENDERED_BLOCKERS);
  const omitted = blockers.length - shown.length;
  const overflow = omitted > 0 ? ` and ${omitted} more` : "";
  const blocking =
    shown.length === 0 ? "" : ` Blocking: ${shown.join(", ")}${overflow}.`;
  return {
    stage,
    cause: `Gate ${stage} failed with ${exit}.${blocking}`,
  };
}

/** Read a failure document from disk, returning null when it is absent or malformed. */
export function readFailureRecord(recordPath) {
  const target = trimmedString(recordPath);
  if (target === "") {
    return null;
  }
  let raw;
  try {
    raw = readFileSync(target, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Render GitHub Actions step outputs for a failure document.
 *
 * Emits nothing when no usable document exists, which is what keeps the
 * workflow's existing preflight fallback in charge of those cases.
 */
export function renderFailureOutputs(recordPath) {
  const described = describeFailureRecord(readFailureRecord(recordPath));
  if (described === null) {
    return "";
  }
  return `failure_stage=${described.stage}\nfailure_cause=${described.cause}\n`;
}

/** CLI entrypoint: print step outputs for the document named by the first argument. */
export function main(argv = process.argv.slice(2)) {
  const rendered = renderFailureOutputs(argv[0] ?? "");
  process.stdout.write(rendered);
  return rendered;
}

/* c8 ignore start -- entrypoint guard is exercised through main() directly. */
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
/* c8 ignore stop */
