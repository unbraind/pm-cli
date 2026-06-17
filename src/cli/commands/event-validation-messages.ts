import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import { resolveIsoOrRelative } from "../../core/shared/time.js";

export const EVENT_END_AFTER_START_MESSAGE =
  "--event end must be strictly after start. Equal start/end timestamps are treated as an instant event (end is dropped); an end earlier than start is rejected. Omit end for an instant event or set end later than start.";

export const EVENT_END_DURATION_MUTUALLY_EXCLUSIVE_MESSAGE =
  "--event end and duration are mutually exclusive; provide only one (use duration=<relative> like duration=2h, duration=30min, or duration=PT30M, or set an explicit end).";

const MINUTE_DURATION = /^([+-]?)(\d+)(min|mins|minute|minutes)$/i;
const ISO_8601_TIME_DURATION = /^([+-]?)[Pp][Tt](?:(\d+)[Hh])?(?:(\d+)[Mm])?(?:(\d+)[Ss])?$/;
const MILLIS_PER_SECOND = 1000;
const MILLIS_PER_MINUTE = 60 * MILLIS_PER_SECOND;
const MILLIS_PER_HOUR = 60 * MILLIS_PER_MINUTE;

function toIsoTimestampOrThrow(timestampMs: number, durationRaw: string): string {
  const resolved = new Date(timestampMs);
  if (!Number.isFinite(resolved.getTime())) {
    throw new PmCliError(
      `Invalid event.duration value "${durationRaw}". Duration is out of supported timestamp range.`,
      EXIT_CODE.USAGE,
    );
  }
  return resolved.toISOString();
}

function resolveDurationAgainstStart(startAt: string, durationRaw: string): string {
  const start = new Date(startAt);
  const trimmedDuration = durationRaw.trim();

  const minuteDuration = MINUTE_DURATION.exec(trimmedDuration);
  if (minuteDuration) {
    const sign = minuteDuration[1] === "-" ? -1 : 1;
    const amount = Number.parseInt(minuteDuration[2], 10) * sign;
    return toIsoTimestampOrThrow(start.getTime() + amount * MILLIS_PER_MINUTE, trimmedDuration);
  }

  const isoDuration = ISO_8601_TIME_DURATION.exec(trimmedDuration);
  if (isoDuration) {
    const [, signToken, hoursToken, minutesToken, secondsToken] = isoDuration;
    const hasComponent = hoursToken || minutesToken || secondsToken;
    if (hasComponent) {
      const sign = signToken === "-" ? -1 : 1;
      const hours = Number.parseInt(hoursToken ?? "0", 10);
      const minutes = Number.parseInt(minutesToken ?? "0", 10);
      const seconds = Number.parseInt(secondsToken ?? "0", 10);
      const totalMillis = hours * MILLIS_PER_HOUR + minutes * MILLIS_PER_MINUTE + seconds * MILLIS_PER_SECOND;
      return toIsoTimestampOrThrow(start.getTime() + sign * totalMillis, trimmedDuration);
    }
  }

  const normalizedDuration =
    trimmedDuration.startsWith("+") || trimmedDuration.startsWith("-") ? trimmedDuration : `+${trimmedDuration}`;
  return resolveIsoOrRelative(normalizedDuration, start, "event.duration");
}

// Shared by `pm create` (parseEvents) and `pm update` (parseEventEntries) so the
// two parallel parse sites cannot drift. Resolves the event end timestamp from
// either an explicit `end` or a relative `duration` (mutually exclusive).
// Equal start/end (including a zero-length duration) collapses to an instant
// event (end dropped); an end earlier than start is rejected.
export function resolveEventEndAt(
  startAt: string,
  endRaw: string | undefined,
  durationRaw: string | undefined,
  referenceDate: Date,
): string | undefined {
  if (endRaw && durationRaw) {
    throw new PmCliError(EVENT_END_DURATION_MUTUALLY_EXCLUSIVE_MESSAGE, EXIT_CODE.USAGE);
  }
  if (durationRaw) {
    // Resolve duration with startAt as the reference so duration=2h means startAt + 2h.
    // Keep global relative token semantics unchanged (`m` stays months) while
    // allowing explicit sub-hour forms (`30min`, `PT30M`) for event durations.
    const endAt = resolveDurationAgainstStart(startAt, durationRaw);
    if (endAt < startAt) {
      throw new PmCliError(EVENT_END_AFTER_START_MESSAGE, EXIT_CODE.USAGE);
    }
    // A zero-length duration is an instant event, mirroring explicit equal start/end.
    if (endAt === startAt) {
      return undefined;
    }
    return endAt;
  }
  if (!endRaw) {
    return undefined;
  }
  const endAt = resolveIsoOrRelative(endRaw, referenceDate, "event.end");
  if (endAt < startAt) {
    throw new PmCliError(EVENT_END_AFTER_START_MESSAGE, EXIT_CODE.USAGE);
  }
  // Equal start/end collapses to an instant event (drop end) instead of being rejected.
  if (endAt === startAt) {
    return undefined;
  }
  return endAt;
}
