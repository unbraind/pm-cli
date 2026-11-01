/**
 * @module core/store/settings-sections
 *
 * Host-owned read and revision-safe write of one extension-owned settings
 * section, so packages never re-read settings.json by path (pm-gh1580).
 */
import { createHash } from "node:crypto";
import { readFileIfExists } from "../fs/fs-utils.js";
import { runActiveOnReadHooks, runActiveOnWriteHooks } from "../extensions/index.js";
import { mutateWorkspaceJsonWithHistory } from "../history/workspace-history.js";
import { resolveAuthor } from "../shared/author.js";
import { EXIT_CODE } from "../shared/constants.js";
import { PmCliError } from "../shared/errors.js";
import { toErrorMessage } from "../shared/primitives.js";
import { stableValueEquals } from "../shared/serialization.js";
import { getSettingsPath } from "./paths.js";
import { readSettings } from "./settings.js";
import { clearSettingsReadCache } from "./settings-read-cache.js";
import { CORE_SETTINGS_SECTION_KEYS } from "./settings-validator.js";

const SETTINGS_SECTION_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const RESERVED_SECTION_NAMES = new Set(["constructor", "prototype"]);
const SETTINGS_SECTION_WRITE_OP = "settings:section:write";
const MAX_VALIDATION_MESSAGE_LENGTH = 240;

/** Validate and normalize a stored section value; throw to refuse it. */
export type SettingsSectionValidator<T> = (raw: unknown) => T;

/** Options for reading one extension-owned settings section. */
export interface ReadSettingsSectionOptions<T> {
  /** Validate the stored value; a throw becomes a typed `settings_section_invalid` refusal. */
  validate?: SettingsSectionValidator<T>;
  /** Value returned, unvalidated, when the section is absent. */
  defaultValue?: T;
}

/** One extension-owned settings section as the host resolved it. */
export interface SettingsSectionReadResult<T> {
  /** Top-level settings key that holds the section. */
  section: string;
  /** `stored` when settings.json holds the section, `default` when it is absent. */
  source: "stored" | "default";
  /** Validated stored value, or the default (undefined when none was given). */
  value: T | undefined;
  /** Content revision of the stored section (`sha256:<hex>`), or null when absent. */
  revision: string | null;
}

/** Options for a revision-safe write of one extension-owned settings section. */
export interface WriteSettingsSectionOptions<T> {
  /** Refuse unless the stored section still has this revision; null requires it to be absent. */
  expectedRevision?: string | null;
  /** Validate and normalize the value before it is stored. */
  validate?: SettingsSectionValidator<T>;
  /**
   * Mutation author for the history event; omitted, the workspace default and
   * detected identity apply. The host-bound `context.sdk` writer passes the
   * invocation author.
   */
  author?: string;
}

/** Receipt of a settings-section write. */
export interface SettingsSectionWriteResult {
  /** Top-level settings key that holds the section. */
  section: string;
  /** Whether settings.json changed. */
  changed: boolean;
  /** Revision before the write, or null when the section was absent. */
  previous_revision: string | null;
  /** Revision after the write, or null when the section was removed. */
  revision: string | null;
}

/** Content revision of a stored section value. */
export function settingsSectionRevision(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalSectionJson(value)).digest("hex")}`;
}

/**
 * Canonical JSON with sorted keys that keeps every own key, including a
 * JSON-parsed `__proto__` entry that an ordinary object accumulator would turn
 * into a prototype assignment, so two different values never share a revision.
 */
function canonicalSectionJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalSectionJson(entry)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalSectionJson(Object.getOwnPropertyDescriptor(value, key)?.value)}`,
      );
    return `{${entries.join(",")}}`;
  }
  // Stored sections are JSON data; String() keeps a non-JSON caller value
  // (undefined) deterministic instead of adding an unreachable fallback.
  return String(JSON.stringify(value));
}

function assertSettingsSectionName(section: string): void {
  if (!SETTINGS_SECTION_NAME_PATTERN.test(section) || RESERVED_SECTION_NAMES.has(section)) {
    throw new PmCliError(
      `Invalid settings section name "${section.slice(0, 80)}". Use 1-64 lowercase letters, digits, underscores or hyphens, starting with a letter.`,
      EXIT_CODE.USAGE,
      {
        code: "settings_section_name_invalid",
        field: "section",
        required: "Name the section after the package, for example lint or jev.",
      },
    );
  }
  if (CORE_SETTINGS_SECTION_KEYS.includes(section)) {
    throw new PmCliError(
      `Settings section "${section}" is owned by core settings; extension sections must use another name.`,
      EXIT_CODE.USAGE,
      {
        code: "settings_section_reserved",
        field: "section",
        value: section,
        required: "Read core settings with readSettings and change them with writeSettings or pm config.",
      },
    );
  }
}

function parseSettingsDocument(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PmCliError(
      "settings.json is not a JSON object, so no settings section can be read or written.",
      EXIT_CODE.USAGE,
      {
        code: "settings_section_document_malformed",
        reason: parsed === undefined ? "settings_json_malformed" : "settings_json_not_object",
        nextSteps: [
          "Repair .agents/pm/settings.json so it is a JSON object, then retry.",
          "Run pm health to confirm the settings warning has cleared.",
        ],
      },
    );
  }
  return parsed as Record<string, unknown>;
}

function validateSectionValue<T>(
  section: string,
  raw: unknown,
  validate: SettingsSectionValidator<T> | undefined,
): T {
  let value: T;
  try {
    value = validate === undefined ? (raw as T) : validate(raw);
  } catch (error: unknown) {
    throw new PmCliError(
      `Settings section "${section}" is invalid: ${toErrorMessage(error).slice(0, MAX_VALIDATION_MESSAGE_LENGTH)}`,
      EXIT_CODE.USAGE,
      {
        code: "settings_section_invalid",
        field: section,
        required: `Fix the "${section}" section of .agents/pm/settings.json so the owning package accepts it, then retry.`,
      },
    );
  }
  return value;
}

/** JSON.stringify calls a function-valued toJSON, own or inherited, enumerable or not. */
function hasJsonHook(value: object): boolean {
  return typeof Reflect.get(value, "toJSON") === "function";
}

function describeJsonPath(segments: readonly string[]): string {
  return segments.length === 0 ? "the value" : segments.join(".");
}

/**
 * Every own property is a data property, so reading it runs no getter, and
 * for objects every one is enumerable, so JSON keeps it. An array's `length`
 * is legitimately non-enumerable; its indices are checked separately.
 */
function hasOnlyDataProperties(value: object, requireEnumerable: boolean): boolean {
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => "value" in descriptor && (!requireEnumerable || descriptor.enumerable === true),
  );
}

/**
 * JSON keeps only an array's dense indices: a hole, an extra or symbol key, a
 * subclass, an accessor or a toJSON hook would store something other than the
 * array.
 */
function isPlainJsonArray(value: unknown[]): boolean {
  // Descriptors before the hook lookup: Reflect.get would run a toJSON getter.
  if (Object.getPrototypeOf(value) !== Array.prototype || !hasOnlyDataProperties(value, false)) {
    return false;
  }
  // Enumerable own keys are exactly the dense indices, and the only other own
  // name is `length`, so no hidden property is dropped by JSON either.
  const keys = Object.keys(value);
  return (
    keys.length === value.length &&
    keys.every((key, index) => key === String(index)) &&
    Object.getOwnPropertyNames(value).length === value.length + 1 &&
    Object.getOwnPropertySymbols(value).length === 0 &&
    !hasJsonHook(value)
  );
}

/** A plain object JSON stores key for key: no prototype, symbol key, accessor, non-enumerable property or toJSON hook. */
function isPlainJsonObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as unknown;
  // Descriptors before the hook lookup: Reflect.get would run a toJSON getter.
  return (
    (prototype === Object.prototype || prototype === null) &&
    hasOnlyDataProperties(value, true) &&
    Object.getOwnPropertySymbols(value).length === 0 &&
    !hasJsonHook(value)
  );
}

/** Why a section value cannot be stored exactly; `representable` is false when JSON cannot hold it at all. */
interface JsonDrift {
  detail: string;
  representable: boolean;
}

function findScalarDrift(value: unknown, segments: readonly string[]): JsonDrift | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") return null;
  const where = describeJsonPath(segments);
  if (typeof value === "number") {
    return Number.isFinite(value) ? null : { detail: `${where} is a non-finite number`, representable: true };
  }
  // bigint throws, and a top-level function, symbol or undefined serializes to
  // nothing; nested ones are dropped or nulled.
  return {
    detail: `${where} is ${typeof value}`,
    representable: typeof value !== "bigint" && segments.length > 0,
  };
}

/**
 * Name the first part of a value that JSON would not store exactly: a
 * non-finite number (stored as null), an undefined, function, symbol or bigint,
 * a symbol key, an accessor, a circular reference, or a non-plain array or
 * object (reshaped through holes, extra keys, its prototype or toJSON). It
 * inspects without serializing, so no hook or getter runs before the value is
 * proven to be plain data. Returns null when the JSON round trip is exact.
 */
function findJsonDrift(
  value: unknown,
  segments: readonly string[] = [],
  ancestors: Set<object> = new Set(),
): JsonDrift | null {
  if (typeof value !== "object" || value === null) return findScalarDrift(value, segments);
  const where = describeJsonPath(segments);
  if (ancestors.has(value)) return { detail: `${where} is a circular reference`, representable: false };
  const plain = Array.isArray(value) ? isPlainJsonArray(value) : isPlainJsonObject(value);
  if (!plain) {
    return { detail: `${where} is not a plain JSON ${Array.isArray(value) ? "array" : "object"}`, representable: true };
  }
  ancestors.add(value);
  for (const [key, entry] of Object.entries(value)) {
    const drift = findJsonDrift(entry, [...segments, key], ancestors);
    if (drift !== null) return drift;
  }
  ancestors.delete(value);
  return null;
}

/**
 * Name the first key path the audited settings history cannot record: an own
 * `__proto__` key, or `prototype` directly beneath `constructor`. The history
 * patcher refuses both, so the write would otherwise fail untyped.
 */
function findReservedJsonKey(value: unknown, segments: readonly string[] = []): string | null {
  if (typeof value !== "object" || value === null) return null;
  for (const [key, entry] of Object.entries(value)) {
    const keyPath = [...segments, key];
    if (key === "__proto__" || (key === "prototype" && segments.at(-1) === "constructor")) {
      return describeJsonPath(keyPath);
    }
    const nested = findReservedJsonKey(entry, keyPath);
    if (nested !== null) return nested;
  }
  return null;
}

/** Raise the typed settings_section_invalid refusal for a value the store cannot hold exactly. */
function refuseSectionValue(section: string, value: unknown, reason: string): unknown {
  return validateSectionValue(section, value, () => {
    throw new Error(reason);
  });
}

/**
 * Snapshot a validated value as the JSON that will be stored. Values JSON
 * cannot represent, or would store differently from what was validated (for
 * example Infinity becoming null), refuse instead of being changed silently.
 */
function toStoredSectionValue(section: string, value: unknown): unknown {
  const drift = findJsonDrift(value);
  if (drift !== null) {
    const reason = drift.representable
      ? `the value would change when stored as JSON: ${drift.detail}`
      : `the value is not representable as JSON: ${drift.detail}`;
    return refuseSectionValue(section, value, reason);
  }
  const reserved = findReservedJsonKey(value);
  if (reserved !== null) {
    return refuseSectionValue(section, value, `${reserved} is a reserved key that settings history cannot record`);
  }
  // Proven plain data: serialization runs no hook or getter and cannot throw.
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function readSectionEntry(document: Record<string, unknown>, section: string): unknown {
  return Object.hasOwn(document, section) ? document[section] : undefined;
}

/**
 * Read one extension-owned top-level section of the tracker's settings through
 * the host. Absent sections resolve to the default; malformed documents and
 * values the validator refuses become typed refusals instead of thrown parse
 * errors.
 */
export async function readSettingsSection<T = unknown>(
  pmRoot: string,
  section: string,
  options: ReadSettingsSectionOptions<T> = {},
): Promise<SettingsSectionReadResult<T>> {
  assertSettingsSectionName(section);
  const settingsPath = getSettingsPath(pmRoot);
  await runActiveOnReadHooks({ path: settingsPath, scope: "project" });
  const raw = await readFileIfExists(settingsPath);
  const stored = raw === null ? undefined : readSectionEntry(parseSettingsDocument(raw), section);
  if (stored === undefined) {
    return { section, source: "default", value: options.defaultValue, revision: null };
  }
  // Hash the stored value before validation and give the validator a detached
  // copy, so an in-place normalizer cannot change the revision a later
  // compare-and-set write must present.
  const revision = settingsSectionRevision(stored);
  return {
    section,
    source: "stored",
    value: validateSectionValue(section, structuredClone(stored), options.validate),
    revision,
  };
}

/**
 * Replace (or, with `undefined`, remove) one extension-owned settings section
 * under the workspace-history lock. Every other key of settings.json is kept
 * byte-for-byte in value. `expectedRevision` makes the write compare-and-set:
 * a section changed since it was read refuses with
 * `settings_section_revision_conflict` and nothing is written.
 */
export async function writeSettingsSection<T>(
  pmRoot: string,
  section: string,
  value: T | undefined,
  options: WriteSettingsSectionOptions<T> = {},
): Promise<SettingsSectionWriteResult> {
  assertSettingsSectionName(section);
  const next =
    value === undefined
      ? undefined
      : toStoredSectionValue(section, validateSectionValue(section, value, options.validate));
  const settingsPath = getSettingsPath(pmRoot);
  const settings = await readSettings(pmRoot);
  try {
    const mutation = await mutateWorkspaceJsonWithHistory({
      pmRoot,
      filePath: settingsPath,
      op: SETTINGS_SECTION_WRITE_OP,
      author: resolveAuthor(options.author, settings.author_default),
      lockTtlSeconds: settings.locks.ttl_seconds,
      lockWaitMs: settings.locks.wait_ms,
      recordCreation: false,
      mutate: (beforeRaw) => {
        if (beforeRaw === null) {
          throw new PmCliError(
            "settings.json does not exist, so no settings section can be written.",
            EXIT_CODE.NOT_FOUND,
            {
              code: "settings_section_document_missing",
              required: "Initialize the tracker with pm init, then retry.",
            },
          );
        }
        const document = parseSettingsDocument(beforeRaw);
        const current = readSectionEntry(document, section);
        const previousRevision = current === undefined ? null : settingsSectionRevision(current);
        if (options.expectedRevision !== undefined && options.expectedRevision !== previousRevision) {
          throw new PmCliError(
            `Settings section "${section}" changed since it was read; read it again and reapply the change.`,
            EXIT_CODE.CONFLICT,
            {
              code: "settings_section_revision_conflict",
              field: section,
              expected_revision: options.expectedRevision,
              current_revision: previousRevision,
              required: "Read the section again with readSettingsSection, then retry with its current revision.",
            },
          );
        }
        const receipt: SettingsSectionWriteResult = {
          section,
          changed: false,
          previous_revision: previousRevision,
          revision: next === undefined ? null : settingsSectionRevision(next),
        };
        if (stableValueEquals(current, next)) return { raw: beforeRaw, result: receipt };
        if (next === undefined) delete document[section];
        else document[section] = next;
        return { raw: `${JSON.stringify(document, null, 2)}\n`, result: { ...receipt, changed: true } };
      },
    });
    if (mutation.changed) {
      await runActiveOnWriteHooks({ path: settingsPath, scope: "project", op: SETTINGS_SECTION_WRITE_OP });
    }
    return mutation.result;
  } finally {
    clearSettingsReadCache(pmRoot);
  }
}
