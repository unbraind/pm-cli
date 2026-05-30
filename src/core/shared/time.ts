import { PmCliError } from "./errors.js";
import { EXIT_CODE } from "./constants.js";

const RELATIVE_DEADLINE = /^([+-]?)(\d+)([hdwm])$/i;
const COMPOUND_RELATIVE_DEADLINE = /^[+-]?\d+[hdwm](?:[+-]\d+[hdwm])+$/i;
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

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

// Leading literal calendar date in either hyphenated (`2026-02-30`) or compact
// (`20260230`) form, optionally followed by any time/zone component. We validate
// the digits the caller actually typed — not the parsed instant — so timezone
// offsets never produce a false "impossible date" rejection. The hyphenated form
// is unambiguous, so anything may follow (`T`/space time, `Z`, `+/-` offset). The
// compact form must be followed by end-of-string or a time digit (with an optional
// `T`/space separator) so a no-separator compact datetime like `20260230135900Z`
// is still guarded and a 7-digit non-date is not misread as a date.
const LEADING_HYPHEN_DATE = /^(\d{4})-(\d{2})-(\d{2})/;
const LEADING_COMPACT_DATE = /^(\d{4})(\d{2})(\d{2})(?:[T ]?\d{2}|$)/;

/**
 * Reject literal calendar dates whose day cannot exist (e.g. `2026-02-30`, which JS
 * `Date` silently rolls forward to March 2). Without this, agents that pass an
 * impossible deadline get a silently-wrong stored date instead of an actionable
 * error. Only triggers on a leading literal date; relative tokens, "now", and pure
 * times are untouched. Month 00 / >12 is also rejected with a clear message rather
 * than falling through to the generic "invalid value" path.
 */
function assertRealCalendarDate(originalInput: string, trimmed: string, fieldLabel: string): void {
  const match = LEADING_HYPHEN_DATE.exec(trimmed) ?? LEADING_COMPACT_DATE.exec(trimmed);
  if (!match) {
    return;
  }
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const label = fieldLabel?.trim() || "deadline";
  if (month < 1 || month > 12) {
    throw new PmCliError(
      `Invalid ${label} value "${originalInput}". Month "${match[2]}" is out of range — use a month between 01 and 12.`,
      EXIT_CODE.USAGE,
    );
  }
  const maxDay = daysInUtcMonth(year, month - 1);
  if (day < 1 || day > maxDay) {
    throw new PmCliError(
      `Invalid ${label} value "${originalInput}". ${MONTH_NAMES[month - 1]} ${year} has ${maxDay} days, so day "${match[3]}" does not exist. Use a real YYYY-MM-DD calendar date.`,
      EXIT_CODE.USAGE,
    );
  }
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
  fieldLabel = "deadline",
): string {
  const trimmed = input.trim();
  if (trimmed.toLowerCase() === "now") {
    return now.toISOString();
  }
  const relative = RELATIVE_DEADLINE.exec(trimmed);
  if (relative) {
    const sign = relative[1] === "-" ? -1 : 1;
    const amount = Number.parseInt(relative[2], 10) * sign;
    const unit = relative[3].toLowerCase();
    if (unit === "m") {
      return addUtcMonths(now, amount).toISOString();
    }
    const msPerUnit = unit === "h" ? 60 * 60 * 1000 : unit === "d" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
    return new Date(now.getTime() + amount * msPerUnit).toISOString();
  }

  assertRealCalendarDate(input, trimmed, fieldLabel);

  const timestamp = parseTimestampWithFallbacks(trimmed);
  if (!Number.isFinite(timestamp)) {
    const normalizedLabel = fieldLabel.trim().length > 0 ? fieldLabel.trim() : "deadline";
    const guidance = COMPOUND_RELATIVE_DEADLINE.test(trimmed)
      ? "Compound relative expressions like +3d+1h are not supported; use a single relative token (for example +3d) or an ISO/date string."
      : 'Use ISO/date string input, "now", or relative +6h/-6h/+1d/-1d/+2w/-2w/+6m/-6m.';
    throw new PmCliError(
      `Invalid ${normalizedLabel} value "${input}". ${guidance}`,
      EXIT_CODE.USAGE,
    );
  }
  return new Date(timestamp).toISOString();
}
