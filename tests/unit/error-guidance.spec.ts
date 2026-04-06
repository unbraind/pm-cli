import { describe, expect, it } from "vitest";
import { formatPmCliErrorForDisplay, formatPmCliErrorForJson } from "../../src/cli/error-guidance.js";

describe("pm cli error guidance context plumbing", () => {
  it("applies PmCliError context fields to JSON envelope output", () => {
    const envelope = formatPmCliErrorForJson(
      "Merge conflict markers detected in item document at line 1",
      2,
      {
        code: "merge_conflict_markers_detected",
        required: "Resolve all conflict markers before retrying.",
        why: "Conflicted item files cannot be parsed deterministically.",
        examples: ['pm history pm-a1b2 --limit 5 --diff', 'pm update pm-a1b2 --status open --message "retry"'],
        nextSteps: ["Resolve markers and rerun command."],
      },
    );

    expect(envelope).toMatchObject({
      type: "urn:pm-cli:error:merge_conflict_markers_detected",
      code: "merge_conflict_markers_detected",
      required: "Resolve all conflict markers before retrying.",
      why: "Conflicted item files cannot be parsed deterministically.",
      exit_code: 2,
    });
    expect(envelope.examples).toEqual([
      "pm history pm-a1b2 --limit 5 --diff",
      'pm update pm-a1b2 --status open --message "retry"',
    ]);
    expect(envelope.next_steps).toEqual(["Resolve markers and rerun command."]);
  });

  it("applies PmCliError context fields to text guidance output", () => {
    const text = formatPmCliErrorForDisplay("History replay failed due to merge conflict markers.", {
      code: "history_merge_conflict_markers_detected",
      required: "Repair history stream markers before restore replay.",
      why: "Replay requires a clean append-only history stream.",
      nextSteps: ["Run pm history <id> --verify and resolve conflicts."],
    });
    expect(text).toContain("Error: History replay failed due to merge conflict markers.");
    expect(text).toContain("What is required:");
    expect(text).toContain("Repair history stream markers before restore replay.");
    expect(text).toContain("Why:");
    expect(text).toContain("Replay requires a clean append-only history stream.");
    expect(text).toContain("Next steps:");
    expect(text).toContain("Run pm history <id> --verify and resolve conflicts.");
  });

  it("returns deterministic item-not-found recovery examples without echoing invalid ids", () => {
    const envelope = formatPmCliErrorForJson("Item pm-does-not-exist not found", 3);
    expect(envelope.code).toBe("item_not_found");
    expect(envelope.examples).toEqual([
      "pm list-open --limit 20",
      'pm search "<keyword>" --limit 10',
    ]);
    expect(envelope.examples?.some((example) => example.includes("pm-does-not-exist"))).toBe(false);
  });
});
