import { PmCliError } from "../shared/errors.js";
import { EXIT_CODE } from "../shared/constants.js";
import { isNoneToken } from "../shared/time.js";

export function parseTags(raw: string): string[] {
  if (isNoneToken(raw) || raw.trim() === "") {
    return [];
  }
  const tags = raw
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((tag) => tag.toLowerCase());
  return Array.from(new Set(tags)).sort((a, b) => a.localeCompare(b));
}

export function parseCsvKv(raw: string, optionName: string): Record<string, string> {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new PmCliError(`${optionName} cannot be empty`, EXIT_CODE.USAGE);
  }

  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  let escaped = false;

  for (const char of trimmed) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (char === "," && !inQuotes) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) {
    parts.push(current.trim());
  }

  const result: Record<string, string> = {};

  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx <= 0) {
      throw new PmCliError(
        `Invalid ${optionName} value "${raw}". Expected key=value pairs separated by commas.`,
        EXIT_CODE.USAGE,
      );
    }
    const key = part.slice(0, idx).trim();
    let value = part.slice(idx + 1).trim();
    if (value.startsWith("\"") && value.endsWith("\"")) {
      value = value.slice(1, -1).replace(/\\"/g, "\"");
    }
    result[key] = value;
  }

  return result;
}

export function parseOptionalNumber(raw: string, optionName: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new PmCliError(`Invalid ${optionName} value "${raw}"`, EXIT_CODE.USAGE);
  }
  return value;
}
