import { describe, expect, it } from "vitest";
import {
  classifyHistoryEvent,
  HISTORY_EVENT_CLASSIFICATION_VERSION,
  type HistoryEntry,
} from "../../../../src/sdk/index.js";

function entry(
  op: string,
  paths: readonly string[] = [],
  eventClass?: HistoryEntry["event_class"],
): Pick<HistoryEntry, "op" | "patch" | "event_class"> {
  return {
    op,
    patch: paths.map((path) => ({ op: "replace", path, value: "value" })),
    ...(eventClass === undefined ? {} : { event_class: eventClass }),
  };
}

describe("history event classification", () => {
  it("publishes a versioned substantive-versus-maintenance contract", () => {
    expect(HISTORY_EVENT_CLASSIFICATION_VERSION).toBe(1);
    expect(classifyHistoryEvent(entry("comment_add"))).toBe("substantive");
    expect(classifyHistoryEvent(entry("release"))).toBe("maintenance");
    expect(classifyHistoryEvent(entry("history:author-acknowledge"))).toBe(
      "maintenance",
    );
    expect(classifyHistoryEvent(entry("history_compact_baseline"))).toBe(
      "maintenance",
    );
    expect(classifyHistoryEvent(entry("tests_remove"))).toBe("maintenance");
    expect(
      classifyHistoryEvent(
        entry("update", [
          "/metadata/updated_at",
          "/metadata/dependencies",
          "/metadata/release",
        ]),
      ),
    ).toBe("maintenance");
    expect(
      classifyHistoryEvent(
        entry("update", ["/front_matter/updated_at", "/front_matter/status"]),
      ),
    ).toBe("substantive");
    expect(classifyHistoryEvent(entry("update", ["/title"]))).toBe(
      "substantive",
    );
  });

  it("honors immutable declarations and fails unknown operations closed", () => {
    expect(classifyHistoryEvent(entry("update", [], "substantive"))).toBe(
      "substantive",
    );
    expect(classifyHistoryEvent(entry("future_operation"))).toBe("substantive");
    expect(
      classifyHistoryEvent({
        ...entry("release"),
        event_class: "future" as HistoryEntry["event_class"],
      }),
    ).toBe("maintenance");
  });
});
