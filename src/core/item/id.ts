/**
 * @module core/item/id
 *
 * Defines item parsing, formatting, and lifecycle helpers for Id.
 */
import crypto from "node:crypto";
import path from "node:path";
import { TYPE_TO_FOLDER } from "../shared/constants.js";
import { pathExists } from "../fs/fs-utils.js";
import { nextReproducibleToken } from "../reproducibility/context.js";

/** Implements normalize prefix for the public runtime surface of this module. */
export function normalizePrefix(input: string | undefined): string {
  const normalized: string[] = [];
  let separatorPending = false;

  for (const character of (input ?? "").toLowerCase()) {
    const codePoint = character.charCodeAt(0);
    const isAsciiDigit = codePoint >= 48 && codePoint <= 57;
    const isAsciiLetter = codePoint >= 97 && codePoint <= 122;
    if (!isAsciiDigit && !isAsciiLetter) {
      separatorPending = normalized.length > 0;
      continue;
    }
    if (separatorPending) {
      normalized.push("-");
      separatorPending = false;
    }
    normalized.push(character);
  }

  if (normalized.length === 0) return "pm-";
  return `${normalized.join("")}-`;
}

/** Implements normalize raw item id for the public runtime surface of this module. */
export function normalizeRawItemId(input: string): string {
  let normalized = input.trim().toLowerCase();
  if (normalized.startsWith("#")) {
    normalized = normalized.slice(1);
  }
  return normalized;
}

/** Implements normalize item id for the public runtime surface of this module. */
export function normalizeItemId(input: string, prefix: string): string {
  const canonicalPrefix = normalizePrefix(prefix);
  const normalized = normalizeRawItemId(input);
  if (normalized.startsWith(canonicalPrefix)) {
    return normalized;
  }
  return `${canonicalPrefix}${normalized}`;
}

function randomToken(length: number): string {
  const reproducibleToken = nextReproducibleToken(length);
  if (reproducibleToken !== undefined) {
    return reproducibleToken;
  }
  let token = "";
  for (let index = 0; index < length; index += 1) {
    token += crypto.randomInt(0, 36).toString(36);
  }
  return token;
}

/** Reserve an identity when either a live item path or its retained history exists. */
async function idExists(
  pmRoot: string,
  id: string,
  typeToFolder: Readonly<Record<string, string>>,
): Promise<boolean> {
  const checks = [...new Set(Object.values(typeToFolder))].flatMap((folder) => [
    path.join(pmRoot, folder, `${id}.md`),
    path.join(pmRoot, folder, `${id}.toon`),
  ]);
  checks.push(path.join(pmRoot, "history", `${id}.jsonl`));
  return (await Promise.all(checks.map((target) => pathExists(target)))).some(
    Boolean,
  );
}

/** Bounds accepted for the configurable random id token length (`ids.token_length`). */
export const ID_TOKEN_LENGTH_MIN = 4;
/** Upper bound for `ids.token_length`; longer tokens stop improving ergonomics without meaningfully improving uniqueness. */
export const ID_TOKEN_LENGTH_MAX = 12;

/** Clamp a configured id token length into the supported bounds, falling back to the 4-character default for non-finite input. */
export function clampIdTokenLength(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return ID_TOKEN_LENGTH_MIN;
  }
  return Math.min(
    ID_TOKEN_LENGTH_MAX,
    Math.max(ID_TOKEN_LENGTH_MIN, Math.trunc(value)),
  );
}

/**
 * Mint a new item id as `<prefix><random base36 token>`. The starting token
 * length comes from the workspace `ids.token_length` setting (default 4) and
 * escalates automatically when the local uniqueness probe keeps colliding.
 * Uniqueness is only verifiable against the local working tree: concurrent
 * branches can still mint the same id independently, which is why longer
 * configured tokens matter for multi-agent workflows and why
 * `pm validate --check-storage-integrity` detects post-merge duplicate-id
 * collisions (GH-600).
 */
export async function generateItemId(
  pmRoot: string,
  prefix: string,
  options: {
    tokenLength?: number;
    typeToFolder?: Readonly<Record<string, string>>;
    probeExisting?: boolean;
  } = {},
): Promise<string> {
  let tokenLength = clampIdTokenLength(options.tokenLength);
  const maxTokenLength = Math.min(
    tokenLength + 6,
    ID_TOKEN_LENGTH_MAX,
  );
  let attempts = 0;

  while (tokenLength <= maxTokenLength) {
    for (let i = 0; i < 32; i += 1) {
      const id = `${normalizePrefix(prefix)}${randomToken(tokenLength)}`;
      const occupied = await (options.probeExisting === false
        ? pathExists(path.join(pmRoot, "history", `${id}.jsonl`))
        : idExists(pmRoot, id, options.typeToFolder ?? TYPE_TO_FOLDER));
      if (!occupied) {
        return id;
      }
      attempts += 1;
    }
    tokenLength += 1;
  }

  throw new Error(`Unable to generate unique id after ${attempts} attempts`);
}
