import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import { resolveIsoOrRelative } from "../../core/shared/time.js";

export const EVENT_END_AFTER_START_MESSAGE =
  "--event end must be strictly after start. Equal start/end timestamps are treated as an instant event (end is dropped); an end earlier than start is rejected. Omit end for an instant event or set end later than start.";

export const EVENT_END_DURATION_MUTUALLY_EXCLUSIVE_MESSAGE =
  "--event end and duration are mutually exclusive; provide only one (use duration=<relative> like duration=2h, or set an explicit end).";

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
    // Reuse the relative-offset parser with startAt as the reference so duration=2h means startAt + 2h.
    const normalizedDuration = durationRaw.startsWith("+") ? durationRaw : `+${durationRaw}`;
    const endAt = resolveIsoOrRelative(normalizedDuration, new Date(startAt), "event.duration");
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
