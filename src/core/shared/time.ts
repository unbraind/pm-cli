import { PmCliError } from "./errors.js";
import { EXIT_CODE } from "./constants.js";

const RELATIVE_DEADLINE = /^\+?(\d+)([hdw])$/i;

export function nowIso(): string {
  return new Date().toISOString();
}

export function isNoneToken(input: string | undefined): boolean {
  if (input === undefined) return false;
  const normalized = input.trim().toLowerCase();
  return normalized === "none" || normalized === "null";
}

export function resolveIsoOrRelative(
  input: string,
  now: Date = new Date(),
): string {
  const trimmed = input.trim();
  const relative = RELATIVE_DEADLINE.exec(trimmed);
  if (relative) {
    const amount = Number.parseInt(relative[1], 10);
    const unit = relative[2].toLowerCase();
    const msPerUnit = unit === "h" ? 60 * 60 * 1000 : unit === "d" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
    return new Date(now.getTime() + amount * msPerUnit).toISOString();
  }

  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) {
    throw new PmCliError(
      `Invalid deadline value "${input}". Use ISO timestamp, +6h, +1d, +2w, or none.`,
      EXIT_CODE.USAGE,
    );
  }
  return new Date(timestamp).toISOString();
}
