/**
 * @module core/item/id
 *
 * Defines item parsing, formatting, and lifecycle helpers for Id.
 */
import crypto from "node:crypto";
import path from "node:path";
import { TYPE_TO_FOLDER } from "../shared/constants.js";
import { pathExists } from "../fs/fs-utils.js";

/**
 * Implements normalize prefix for the public runtime surface of this module.
 */
export function normalizePrefix(input: string | undefined): string {
  const normalized = (input ?? "").trim().toLowerCase();
  if (!normalized) return "pm-";
  return normalized.endsWith("-") ? normalized : `${normalized}-`;
}

/**
 * Implements normalize raw item id for the public runtime surface of this module.
 */
export function normalizeRawItemId(input: string): string {
  let normalized = input.trim().toLowerCase();
  if (normalized.startsWith("#")) {
    normalized = normalized.slice(1);
  }
  return normalized;
}

/**
 * Implements normalize item id for the public runtime surface of this module.
 */
export function normalizeItemId(input: string, prefix: string): string {
  const canonicalPrefix = normalizePrefix(prefix);
  const normalized = normalizeRawItemId(input);
  if (normalized.startsWith(canonicalPrefix)) {
    return normalized;
  }
  return `${canonicalPrefix}${normalized}`;
}

function randomToken(length: number): string {
  let token = "";
  for (let index = 0; index < length; index += 1) {
    token += crypto.randomInt(0, 36).toString(36);
  }
  return token;
}

async function idExists(pmRoot: string, id: string): Promise<boolean> {
  const checks = Object.values(TYPE_TO_FOLDER).flatMap((folder) => [
    path.join(pmRoot, folder, `${id}.md`),
    path.join(pmRoot, folder, `${id}.toon`),
  ]);
  for (const target of checks) {
    if (await pathExists(target)) {
      return true;
    }
  }
  return false;
}

/**
 * Implements generate item id for the public runtime surface of this module.
 */
export async function generateItemId(pmRoot: string, prefix: string): Promise<string> {
  let tokenLength = 4;
  let attempts = 0;

  while (tokenLength <= 10) {
    for (let i = 0; i < 32; i += 1) {
      const id = `${normalizePrefix(prefix)}${randomToken(tokenLength)}`;
      if (!(await idExists(pmRoot, id))) {
        return id;
      }
      attempts += 1;
    }
    tokenLength += 1;
  }

  throw new Error(`Unable to generate unique id after ${attempts} attempts`);
}
