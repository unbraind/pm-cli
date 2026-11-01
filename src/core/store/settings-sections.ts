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
import { stableStringify, stableValueEquals } from "../shared/serialization.js";
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
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
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

/** Snapshot a validated value as the JSON that will be stored, refusing values JSON cannot represent. */
function toStoredSectionValue(section: string, value: unknown): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = undefined;
  }
  if (serialized === undefined) {
    return validateSectionValue(section, value, () => {
      throw new Error("the value is not representable as JSON");
    });
  }
  return JSON.parse(serialized) as unknown;
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
  return {
    section,
    source: "stored",
    value: validateSectionValue(section, stored, options.validate),
    revision: settingsSectionRevision(stored),
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
      author: resolveAuthor(undefined, settings.author_default),
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
