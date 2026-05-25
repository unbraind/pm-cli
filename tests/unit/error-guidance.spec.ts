import { describe, expect, it } from "vitest";
import {
  formatCommanderErrorForDisplay,
  formatCommanderErrorForJson,
  formatPmCliErrorForDisplay,
  formatPmCliErrorForJson,
} from "../../src/cli/error-guidance.js";

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

  it("explains that update --message must accompany a real field mutation", () => {
    const envelope = formatPmCliErrorForJson("No update flags provided", 2);

    expect(envelope.code).toBe("no_update_fields");
    expect(envelope.required).toContain("field-changing flag");
    expect(envelope.required).toContain("Use --message only to label a real mutation.");
    expect(envelope.required).not.toContain("or --message");
    expect(envelope.examples).toEqual([
      'pm update pm-a1b2 --status in_progress --message "Start implementation"',
      'pm update pm-a1b2 --description "Clarified implementation scope" --message "Clarify task intent"',
      'pm append pm-a1b2 --body "Detailed progress notes" --message "Append progress notes"',
    ]);
    expect(envelope.next_steps).toContain(
      "Use pm comments, pm notes, pm learnings, or pm append when you only need to add narrative context.",
    );
  });

  it("classifies requires-style validation messages as invalid argument values", () => {
    const envelope = formatPmCliErrorForJson("--reminder requires at=<iso|relative> and text=<value>", 2);

    expect(envelope.code).toBe("invalid_argument_value");
    expect(envelope.title).toBe("Invalid argument value");
    expect(envelope.required).toContain("documented command constraints");
  });

  it("uses attempted command context for allowed-value retry guidance", () => {
    const envelope = formatPmCliErrorForJson("Get --depth must be one of brief|standard|deep", 2, {
      recovery: {
        attempted_command: "pm get pm-rnpb --depth full",
        normalized_args: ["get", "pm-rnpb", "--depth", "full"],
        provided_fields: ["--depth"],
      },
    });

    expect(envelope.code).toBe("invalid_argument_value");
    expect(envelope.examples).toEqual(["pm get pm-rnpb --depth brief", "pm get --help"]);
    expect(envelope.next_steps).toEqual([
      "Allowed values: brief|standard|deep",
      'Run "pm get --help" to confirm command-specific constraints.',
    ]);
  });

  it("surfaces nearest options and cross-command flag hints for unknown options", () => {
    const envelope = formatCommanderErrorForJson("unknown option '--type'", "test-all", "Task|Issue", 2, {
      unknownOptionSuggestions: ["--tag"],
      unknownOptionOtherCommands: ["create", "list", "list-all"],
    });
    expect(envelope.code).toBe("unknown_option");
    expect(envelope.next_steps).toEqual(
      expect.arrayContaining([
        "Nearest supported options: --tag",
        "--type is a valid option on: create, list, list-all. If you meant one of those, run that command instead.",
      ]),
    );

    const guidance = formatCommanderErrorForDisplay("unknown option '--type'", "test-all", "Task|Issue", {
      unknownOptionOtherCommands: ["create", "list", "list-all"],
    });
    expect(guidance).toContain("--type is a valid option on: create, list, list-all");
  });

  it("applies runtime unknown-command guidance examples for commander errors", () => {
    const envelope = formatCommanderErrorForJson("unknown command 'beads'", "help", "Task|Issue", 2, {
      unknownCommandExamples: ["pm --help", "pm list-open --help", "pm context --help"],
      unknownCommandNextSteps: [
        'Run "pm --help" to inspect available command paths in this runtime.',
        'Use one of the suggested command paths with "--help".',
      ],
    });

    expect(envelope.code).toBe("unknown_command");
    expect(envelope.examples).toEqual(["pm --help", "pm list-open --help", "pm context --help"]);
    expect(envelope.next_steps).toEqual([
      'Run "pm --help" to inspect available command paths in this runtime.',
      'Use one of the suggested command paths with "--help".',
    ]);

    const guidance = formatCommanderErrorForDisplay("unknown command 'beads'", "help", "Task|Issue", {
      unknownCommandExamples: ["pm --help", "pm list-open --help"],
    });
    expect(guidance).toContain("pm list-open --help");
    expect(guidance).not.toContain("pm todos --help");
  });

  it("adds a concrete install hint for known package-provided commands", () => {
    const guideEnvelope = formatCommanderErrorForJson("unknown command 'guide'", "help", "Task|Issue", 2, {
      unknownCommandExamples: ["pm --help"],
      unknownCommandNextSteps: ["Verify spelling and active extensions, then rerun."],
    });
    expect(guideEnvelope.code).toBe("unknown_command");
    expect(guideEnvelope.detail).toContain("@unbrained/pm-guide-shell");
    expect(guideEnvelope.examples).toContain("pm install guide-shell");
    expect(guideEnvelope.next_steps?.some((step) => step.includes("pm install guide-shell"))).toBe(true);
    expect(guideEnvelope.next_steps).toContain("Verify spelling and active extensions, then rerun.");

    const templatesGuidance = formatCommanderErrorForDisplay("unknown command 'templates'", "help", "Task|Issue");
    expect(templatesGuidance).toContain("@unbrained/pm-templates");
    expect(templatesGuidance).toContain("pm install templates");

    const calGuidance = formatCommanderErrorForDisplay("unknown command 'cal'", "help", "Task|Issue");
    expect(calGuidance).toContain("@unbrained/pm-calendar");
    expect(calGuidance).toContain("pm install calendar");

    const calendarEnvelope = formatCommanderErrorForJson("unknown command 'calendar'", "help", "Task|Issue", 2);
    expect(calendarEnvelope.examples).toContain("pm install calendar");
  });

  it("does not add a package install hint for genuinely unknown commands", () => {
    const envelope = formatCommanderErrorForJson("unknown command 'frobnicate'", "help", "Task|Issue", 2, {
      unknownCommandExamples: ["pm --help"],
      unknownCommandNextSteps: ["Verify spelling and active extensions, then rerun."],
    });
    expect(envelope.code).toBe("unknown_command");
    expect(envelope.detail).not.toContain("@unbrained/");
    expect(envelope.examples).toEqual(["pm --help"]);
    expect(envelope.next_steps).toEqual(["Verify spelling and active extensions, then rerun."]);
  });

  it("normalizes commander required-option labels before building retry guidance", () => {
    const envelope = formatCommanderErrorForJson(
      "error: required option '--description, -d <value>' not specified",
      "create",
      "Task|Issue",
      2,
      {
        attemptedCommand: 'pm create --title "Agent fast command loop" --type Task',
        normalizedInvocationArgs: ["create", "--title", "Agent fast command loop", "--type", "Task"],
        providedOptionFlags: ["--title", "--type"],
        suggestedRetryCommand: 'pm create --title "Agent fast command loop" --type Task --description <value>',
      },
    );

    expect(envelope.title).toBe("Missing required option --description");
    expect(envelope.required).toBe("Pass --description with a valid value before running the command.");
    expect(envelope.recovery?.missing).toEqual(["--description"]);
    expect(envelope.recovery?.suggested_retry).toBe(
      'pm create --title "Agent fast command loop" --type Task --description <value>',
    );
    expect(envelope.recovery?.suggested_retry).not.toContain("--description,");
  });
});
