export const EVENT_END_AFTER_START_MESSAGE =
  "--event end must be strictly after start. Equal start/end timestamps are treated as an instant event (end is dropped); an end earlier than start is rejected. Omit end for an instant event or set end later than start.";

export const EVENT_END_DURATION_MUTUALLY_EXCLUSIVE_MESSAGE =
  "--event end and duration are mutually exclusive; provide only one (use duration=<relative> like duration=2h, or set an explicit end).";
