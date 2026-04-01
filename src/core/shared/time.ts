import { PmCliError } from "./errors.js";
import { EXIT_CODE } from "./constants.js";

const RELATIVE_DEADLINE = /^\+?(\d+)([hdwm])$/i;
const COMPACT_DATE = /^(\d{4})(\d{2})(\d{2})$/;
const COMPACT_DATETIME = /^(\d{4})(\d{2})(\d{2})(?:[T\s]?)(\d{2})(\d{2})(\d{2})?([.,]\d{1,3})?(Z|[+-]\d{2}:?\d{2})?$/i;
const HYPHEN_TIME = /^(\d{4}-\d{2}-\d{2})[T\s](\d{2})-(\d{2})(?:-(\d{2}))?([.,]\d{1,3})?(Z|[+-]\d{2}:?\d{2})?$/i;
const COMPACT_TIME = /^(\d{4}-\d{2}-\d{2})[T\s](\d{2})(\d{2})(\d{2})?([.,]\d{1,3})?(Z|[+-]\d{2}:?\d{2})?$/i;

export function nowIso(): string {
  return new Date().toISOString();
}

export function isTimestampLiteral(input: string): boolean {
  return Number.isFinite(Date.parse(input));
}

export function compareTimestampStrings(left: string, right: string): number {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs) {
    return leftMs - rightMs;
  }
  return left.localeCompare(right);
}

export function isNoneToken(input: string | undefined): boolean {
  if (input === undefined) return false;
  const normalized = input.trim().toLowerCase();
  return normalized === "none" || normalized === "null";
}

function normalizeFraction(raw: string | undefined): string {
  if (!raw) return "";
  const digits = raw.slice(1);
  return `.${digits.padEnd(3, "0").slice(0, 3)}`;
}

function normalizeOffset(raw: string | undefined): string {
  if (!raw) return "";
  if (raw.toUpperCase() === "Z") return "Z";
  const compact = /^([+-]\d{2})(\d{2})$/.exec(raw);
  if (compact) return `${compact[1]}:${compact[2]}`;
  return raw;
}

function normalizeTimestampCandidates(input: string): string[] {
  const candidates: string[] = [];
  const push = (value: string | undefined): void => {
    if (!value || value === input || candidates.includes(value)) return;
    candidates.push(value);
  };

  const compactDate = COMPACT_DATE.exec(input);
  if (compactDate) {
    const [, year, month, day] = compactDate;
    push(`${year}-${month}-${day}`);
  }

  const compactDateTime = COMPACT_DATETIME.exec(input);
  if (compactDateTime) {
    const [, year, month, day, hour, minute, secondRaw, fractionRaw, offsetRaw] = compactDateTime;
    const second = secondRaw ? `:${secondRaw}` : "";
    push(
      `${year}-${month}-${day}T${hour}:${minute}${second}${normalizeFraction(fractionRaw)}${normalizeOffset(offsetRaw)}`,
    );
  }

  const hyphenTime = HYPHEN_TIME.exec(input);
  if (hyphenTime) {
    const [, datePart, hour, minute, secondRaw, fractionRaw, offsetRaw] = hyphenTime;
    const second = secondRaw ? `:${secondRaw}` : "";
    push(`${datePart}T${hour}:${minute}${second}${normalizeFraction(fractionRaw)}${normalizeOffset(offsetRaw)}`);
  }

  const compactTime = COMPACT_TIME.exec(input);
  if (compactTime) {
    const [, datePart, hour, minute, secondRaw, fractionRaw, offsetRaw] = compactTime;
    const second = secondRaw ? `:${secondRaw}` : "";
    push(`${datePart}T${hour}:${minute}${second}${normalizeFraction(fractionRaw)}${normalizeOffset(offsetRaw)}`);
  }

  const spaceDateTime = /^(\d{4}-\d{2}-\d{2})\s+(.+)$/.exec(input);
  if (spaceDateTime) {
    const [, datePart, timePart] = spaceDateTime;
    push(`${datePart}T${timePart}`);
  }

  return candidates;
}

function parseTimestampWithFallbacks(input: string): number {
  const direct = Date.parse(input);
  if (Number.isFinite(direct)) return direct;
  for (const candidate of normalizeTimestampCandidates(input)) {
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NaN;
}

function daysInUtcMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function addUtcMonths(now: Date, amount: number): Date {
  const result = new Date(now.getTime());
  const startDay = result.getUTCDate();
  const targetMonthIndex = result.getUTCMonth() + amount;
  const targetYear = result.getUTCFullYear() + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const day = Math.min(startDay, daysInUtcMonth(targetYear, targetMonth));
  result.setUTCFullYear(targetYear, targetMonth, day);
  return result;
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
    if (unit === "m") {
      return addUtcMonths(now, amount).toISOString();
    }
    const msPerUnit = unit === "h" ? 60 * 60 * 1000 : unit === "d" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
    return new Date(now.getTime() + amount * msPerUnit).toISOString();
  }

  const timestamp = parseTimestampWithFallbacks(trimmed);
  if (!Number.isFinite(timestamp)) {
    throw new PmCliError(
      `Invalid deadline value "${input}". Use ISO/date string input, relative +6h/+1d/+2w/+6m, or none.`,
      EXIT_CODE.USAGE,
    );
  }
  return new Date(timestamp).toISOString();
}
