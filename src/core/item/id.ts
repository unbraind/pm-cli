import crypto from "node:crypto";
import path from "node:path";
import { TYPE_TO_FOLDER } from "../shared/constants.js";
import { pathExists } from "../fs/fs-utils.js";

export function normalizePrefix(input: string | undefined): string {
  const normalized = (input ?? "").trim().toLowerCase();
  if (!normalized) return "pm-";
  return normalized.endsWith("-") ? normalized : `${normalized}-`;
}

export function normalizeItemId(input: string, prefix: string): string {
  const canonicalPrefix = normalizePrefix(prefix);
  let normalized = input.trim().toLowerCase();
  if (normalized.startsWith("#")) {
    normalized = normalized.slice(1);
  }
  if (normalized.startsWith(canonicalPrefix)) {
    return normalized;
  }
  return `${canonicalPrefix}${normalized}`;
}

function randomToken(length: number): string {
  const bytes = crypto.randomBytes(length);
  let token = "";
  for (const byte of bytes) {
    token += (byte % 36).toString(36);
  }
  return token;
}

async function idExists(pmRoot: string, id: string): Promise<boolean> {
  const checks = Object.values(TYPE_TO_FOLDER).map((folder) => path.join(pmRoot, folder, `${id}.md`));
  for (const target of checks) {
    if (await pathExists(target)) {
      return true;
    }
  }
  return false;
}

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
