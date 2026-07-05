import { describe, expect, it } from "vitest";
import {
  _testOnly,
  buildLinkedTestQuotedRetryCommand,
  classifyUnknownError,
  formatCommanderErrorForDisplay,
  formatCommanderErrorForJson,
  formatPmCliErrorForDisplay,
  formatPmCliErrorForJson,
  formatUnknownErrorForJson,
} from "../../../src/cli/error-guidance.js";

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

  it("normalizes compact recovery arrays defensively", () => {
    const envelope = formatPmCliErrorForJson("Missing required option --message for type \"Task\"", 2, {
      code: "missing_required_option",
      recovery: {
        recovery_mode: "compact",
        missing_required_fields: [" --message ", 123, null, ""] as unknown as string[],
        suggested_flags: [" --create-mode progressive ", false, "--message"] as unknown as string[],
        retry_after_ms: 250,
      },
    });

    expect(envelope.recovery).toMatchObject({
      recovery_mode: "compact",
      missing_required_fields: ["--message"],
      suggested_flags: ["--create-mode progressive", "--message"],
      retry_after_ms: 250,
    });
  });

  it("applies PmCliError context fields to text guidance output", () => {
    const text = formatPmCliErrorForDisplay("History replay failed due to merge conflict markers.", {
      code: "history_merge_conflict_markers_detected",
      required: "Repair history stream markers before restore replay.",
      why: "Replay requires a clean append-only history stream.",
      nextSteps: ["Run pm history <id> --verify and resolve conflicts."],
      recovery: { retry_after_ms: 250 },
    });
    expect(text).toContain("Error: History replay failed due to merge conflict markers.");
    expect(text).toContain("What is required:");
    expect(text).toContain("Repair history stream markers before restore replay.");
    expect(text).toContain("Why:");
    expect(text).toContain("Replay requires a clean append-only history stream.");
    expect(text).toContain("Next steps:");
    expect(text).toContain("Run pm history <id> --verify and resolve conflicts.");
    expect(text).toContain("retry_after_ms: 250");
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
    const envelope = formatPmCliErrorForJson("Get --depth must be one of brief|standard|deep|full", 2, {
      recovery: {
        attempted_command: "pm get pm-rnpb --depth verbose",
        normalized_args: ["get", "pm-rnpb", "--depth", "verbose"],
        provided_fields: ["--depth"],
      },
    });

    expect(envelope.code).toBe("invalid_argument_value");
    expect(envelope.examples).toEqual(["pm get pm-rnpb --depth brief", "pm get --help"]);
    expect(envelope.next_steps).toEqual([
      "Allowed values: brief|standard|deep|full",
      'Run "pm get --help" to confirm command-specific constraints.',
    ]);
  });

  it("preserves structured fallback recovery candidates in JSON and text output", () => {
    const recovery = {
      attempted_command: "pm install --project npm:pm-brief",
      fallback_candidates: [
        {
          source: "github.com/unbraind/pm-brief",
          command: "pm install --project github.com/unbraind/pm-brief",
          reason: "canonical first-party GitHub repository fallback",
        },
      ],
      next_best_command: "pm install --project github.com/unbraind/pm-brief",
    };
    const envelope = formatPmCliErrorForJson("npm package \"pm-brief\" was not found in the registry.", 3, {
      code: "npm_package_not_found",
      recovery,
    });
    expect(envelope.recovery).toMatchObject(recovery);

    const text = formatPmCliErrorForDisplay("npm package \"pm-brief\" was not found in the registry.", {
      code: "npm_package_not_found",
      recovery,
    });
    expect(text).toContain("next_best_command: pm install --project github.com/unbraind/pm-brief");
    expect(text).toContain("github.com/unbraind/pm-brief");
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
    expect(envelope.why).toBeUndefined();

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

  it("covers every optional-package command root with an install hint", () => {
    const expectations: Array<[command: string, packageName: string, installCommand: string]> = [
      ["completion", "@unbrained/pm-guide-shell", "pm install guide-shell"],
      ["completion-statuses", "@unbrained/pm-guide-shell", "pm install guide-shell"],
      ["completion-tags", "@unbrained/pm-guide-shell", "pm install guide-shell"],
      ["completion-types", "@unbrained/pm-guide-shell", "pm install guide-shell"],
      ["shell", "@unbrained/pm-guide-shell", "pm install guide-shell"],
      ["comments-audit", "@unbrained/pm-governance-audit", "pm install governance-audit"],
      ["dedupe-audit", "@unbrained/pm-governance-audit", "pm install governance-audit"],
      ["dedupe-merge", "@unbrained/pm-governance-audit", "pm install governance-audit"],
      ["normalize", "@unbrained/pm-governance-audit", "pm install governance-audit"],
      ["reindex", "@unbrained/pm-search-advanced", "pm install search-advanced"],
      ["search-advanced", "@unbrained/pm-search-advanced", "pm install search-advanced"],
      ["test-runs", "@unbrained/pm-linked-test-adapters", "pm install linked-test-adapters"],
    ];
    for (const [command, packageName, installCommand] of expectations) {
      const envelope = formatCommanderErrorForJson(`unknown command '${command}'`, "help", "Task|Issue", 2);
      expect(envelope.detail, command).toContain(packageName);
      expect(envelope.examples, command).toContain(installCommand);
    }
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

  it("classifies module resolution failures with concrete recovery guidance", () => {
    const envelope = formatUnknownErrorForJson(
      "Cannot find module '[redacted_path]' imported from [redacted_path]",
      1,
    );

    expect(envelope.code).toBe("module_import_failed");
    expect(envelope.title).toBe("Module import failed");
    expect(envelope.examples).toEqual([
      "pnpm build",
      "pm package manage --doctor --project",
      "pm health --check-only --json",
    ]);
    expect(envelope.next_steps).toContain("Rebuild the checkout or package that provides the missing module.");

    const classified = classifyUnknownError("ERR_MODULE_NOT_FOUND: Cannot find package '@example/missing'");
    expect(classified.code).toBe("module_import_failed");

    const generic = formatUnknownErrorForJson("Unexpected runtime failure", 1);
    expect(generic.code).toBe("unknown_error");
  });
});

describe("linked-test value quoting guidance (GH-191)", () => {
  const ALLOWED_TYPES = "Task|Issue";
  const TOO_MANY = "error: too many arguments for 'test'. Expected 1 argument but got 4.";

  it("classifies an unquoted test --add value as linked_test_value_not_quoted with a re-joined retry", () => {
    const envelope = formatCommanderErrorForJson(TOO_MANY, "test", ALLOWED_TYPES, 2, {
      normalizedInvocationArgs: ["test", "pm-a1b2", "--add", "command", "npm", "test", "--", "parser"],
      providedOptionFlags: ["--add"],
    });

    expect(envelope.code).toBe("linked_test_value_not_quoted");
    expect(envelope.title).toBe("Linked-test --add value must be one argument");
    expect(envelope.required).toContain('--add "command=npm test -- parser"');
    expect(envelope.required).toContain("two-token form");
    expect(envelope.recovery?.suggested_retry).toBe('pm test pm-a1b2 --add "command=npm test -- parser"');
    expect(envelope.examples?.[0]).toBe('pm test pm-a1b2 --add "command=npm test -- parser"');
    expect(envelope.examples).toContain('pm test pm-a1b2 --add command "npm test -- parser"');
    expect(envelope.examples).toContain(`pm test pm-a1b2 --add-json '{"command":"npm test -- parser"}'`);
    expect(envelope.next_steps?.[0]).toContain("Replay with the value re-joined into one argument:");
  });

  it("targets guidance without a retry when the value tokens cannot be re-joined unambiguously", () => {
    const envelope = formatCommanderErrorForJson(TOO_MANY, "test", ALLOWED_TYPES, 2, {
      normalizedInvocationArgs: ["test", "--add", "command", "echo x -- y", "pm-a1b2"],
    });

    expect(envelope.code).toBe("linked_test_value_not_quoted");
    expect(envelope.recovery?.suggested_retry).toBeUndefined();
    expect(envelope.next_steps?.[0]).toContain("--add-json");
  });

  it("detects --add-json and inline --add= forms as linked-test mutations", () => {
    const addJson = formatCommanderErrorForJson(TOO_MANY, "test", ALLOWED_TYPES, 2, {
      normalizedInvocationArgs: ["test", "pm-a1b2", "--add-json", "{command:", "x}"],
    });
    expect(addJson.code).toBe("linked_test_value_not_quoted");
    expect(addJson.title).toBe("Linked-test --add-json value must be one argument");
    expect(addJson.recovery?.suggested_retry).toBeUndefined();

    const inline = formatCommanderErrorForJson(TOO_MANY, "test", ALLOWED_TYPES, 2, {
      normalizedInvocationArgs: ["test", "pm-a1b2", "--add=command", "extra"],
    });
    expect(inline.code).toBe("linked_test_value_not_quoted");
  });

  it("keeps generic usage guidance for test excess arguments without linked-test flags", () => {
    const envelope = formatCommanderErrorForJson(TOO_MANY, "test", ALLOWED_TYPES, 2, {
      normalizedInvocationArgs: ["test", "pm-a1b2", "extra", "--run"],
    });
    expect(envelope.code).toBe("invalid_command_usage");

    const noContext = formatCommanderErrorForJson(TOO_MANY, "test", ALLOWED_TYPES, 2);
    expect(noContext.code).toBe("invalid_command_usage");
  });

  it("keeps generic usage guidance for other commands and other messages", () => {
    const otherCommand = formatCommanderErrorForJson(
      "error: too many arguments for 'get'. Expected 1 argument but got 2.",
      "get",
      ALLOWED_TYPES,
      2,
      { normalizedInvocationArgs: ["get", "pm-a1b2", "--add", "command", "x", "y"] },
    );
    expect(otherCommand.code).toBe("invalid_command_usage");

    const otherMessage = formatCommanderErrorForJson("error: something else entirely", "test", ALLOWED_TYPES, 2, {
      normalizedInvocationArgs: ["test", "pm-a1b2", "--add", "command", "x", "y"],
    });
    expect(otherMessage.code).toBe("invalid_command_usage");
  });

  it("renders the targeted guidance in text output", () => {
    const text = formatCommanderErrorForDisplay(TOO_MANY, "test", ALLOWED_TYPES, {
      normalizedInvocationArgs: ["test", "pm-a1b2", "--add", "command", "npm", "test", "--", "parser"],
    });
    expect(text).toContain("Linked-test --add value must be one argument");
    expect(text).toContain('pm test pm-a1b2 --add "command=npm test -- parser"');
  });
});

describe("context item-argument guidance", () => {
  const ALLOWED_TYPES = "Task|Issue";
  const TOO_MANY = "error: too many arguments for 'context'. Expected 0 arguments but got 1: pm-a1b2.";

  it("routes pm context <id> to pm get and pm context --parent", () => {
    const envelope = formatCommanderErrorForJson(TOO_MANY, "context", ALLOWED_TYPES, 2, {
      normalizedInvocationArgs: ["context", "pm-a1b2"],
    });

    expect(envelope.code).toBe("context_takes_no_item_argument");
    expect(envelope.required).toContain("pm get pm-a1b2");
    expect(envelope.required).toContain("pm context --parent pm-a1b2");
    expect(envelope.examples).toContain("pm get pm-a1b2");
    expect(envelope.recovery?.suggested_retry).toBe("pm get pm-a1b2");
  });

  it("uses Commander's offending argument when context flags already contain item ids", () => {
    const envelope = formatCommanderErrorForJson(
      "error: too many arguments for 'context'. Expected 0 arguments but got 1: extra-arg.",
      "context",
      ALLOWED_TYPES,
      2,
      {
        normalizedInvocationArgs: ["context", "--parent", "pm-a1b2", "extra-arg"],
      },
    );

    expect(envelope.code).toBe("context_takes_no_item_argument");
    expect(envelope.required).toContain("pm get extra-arg");
    expect(envelope.required).toContain("pm context --parent extra-arg");
    expect(envelope.recovery?.suggested_retry).toBe("pm get extra-arg");
  });

  it("preserves dotted offending arguments from Commander messages", () => {
    const envelope = formatCommanderErrorForJson(
      "error: too many arguments for 'context'. Expected 0 arguments but got 1: pm-a1b2.toon.",
      "context",
      ALLOWED_TYPES,
      2,
      {
        normalizedInvocationArgs: ["context", "pm-a1b2.toon"],
      },
    );

    expect(envelope.code).toBe("context_takes_no_item_argument");
    expect(envelope.required).toContain("pm get pm-a1b2.toon");
    expect(envelope.recovery?.suggested_retry).toBe("pm get pm-a1b2.toon");
  });

  it("falls back to alias-aware positional parsing for pm ctx", () => {
    const envelope = formatCommanderErrorForJson(
      "error: too many arguments for 'context'. Expected 0 arguments.",
      "context",
      ALLOWED_TYPES,
      2,
      {
        normalizedInvocationArgs: ["ctx", "pm-a1b2"],
      },
    );

    expect(envelope.code).toBe("context_takes_no_item_argument");
    expect(envelope.recovery?.suggested_retry).toBe("pm get pm-a1b2");
  });

  it("accepts raw ctx as the command name for context argument guidance", () => {
    const envelope = formatCommanderErrorForJson(
      "error: too many arguments for 'context'. Expected 0 arguments.",
      "ctx",
      ALLOWED_TYPES,
      2,
      {
        normalizedInvocationArgs: ["ctx", "pm-a1b2"],
      },
    );

    expect(envelope.code).toBe("context_takes_no_item_argument");
    expect(envelope.recovery?.suggested_retry).toBe("pm get pm-a1b2");
  });

  it("ignores known context flag values when falling back to argv positional parsing", () => {
    const envelope = formatCommanderErrorForJson(
      "error: too many arguments for 'context'. Expected 0 arguments.",
      "context",
      ALLOWED_TYPES,
      2,
      {
        normalizedInvocationArgs: ["context", "--parent", "pm-a1b2", "extra-arg"],
      },
    );

    expect(envelope.code).toBe("context_takes_no_item_argument");
    expect(envelope.recovery?.suggested_retry).toBe("pm get extra-arg");
  });

  it("ignores global pm path flag values when falling back to argv positional parsing", () => {
    const envelope = formatCommanderErrorForJson(
      "error: too many arguments for 'context'. Expected 0 arguments.",
      "context",
      ALLOWED_TYPES,
      2,
      {
        normalizedInvocationArgs: ["context", "--pm-path", "/tmp/project/.agents/pm", "--path=/tmp/legacy", "pm-a1b2"],
      },
    );

    expect(envelope.code).toBe("context_takes_no_item_argument");
    expect(envelope.recovery?.suggested_retry).toBe("pm get pm-a1b2");
  });

  it("ignores context value flag arguments when falling back to argv positional parsing", () => {
    const envelope = formatCommanderErrorForJson(
      "error: too many arguments for 'context'. Expected 0 arguments.",
      "context",
      ALLOWED_TYPES,
      2,
      {
        normalizedInvocationArgs: [
          "context",
          "--date",
          "today",
          "--limit",
          "5",
          "--section=focus",
          "--fields",
          "id,title",
          "pm-a1b2",
        ],
      },
    );

    expect(envelope.code).toBe("context_takes_no_item_argument");
    expect(envelope.recovery?.suggested_retry).toBe("pm get pm-a1b2");
  });

  it("skips dash-prefixed context flags before fallback positional arguments", () => {
    const envelope = formatCommanderErrorForJson(
      "error: too many arguments for 'context'. Expected 0 arguments.",
      "context",
      ALLOWED_TYPES,
      2,
      {
        normalizedInvocationArgs: ["context", "--json", "pm-a1b2"],
      },
    );

    expect(envelope.code).toBe("context_takes_no_item_argument");
    expect(envelope.recovery?.suggested_retry).toBe("pm get pm-a1b2");
  });

  it("keeps generic usage guidance when no positional token is present", () => {
    const flagOnly = formatCommanderErrorForJson("error: too many arguments for 'context'. Expected 0 arguments.", "context", ALLOWED_TYPES, 2, {
      normalizedInvocationArgs: ["context", "--parent"],
    });
    expect(flagOnly.code).toBe("invalid_command_usage");

    const noContext = formatCommanderErrorForJson("error: too many arguments for 'context'. Expected 0 arguments.", "context", ALLOWED_TYPES, 2);
    expect(noContext.code).toBe("invalid_command_usage");

    const unknownCommandName = formatCommanderErrorForJson(
      "error: too many arguments for 'context'. Expected 0 arguments.",
      undefined,
      ALLOWED_TYPES,
      2,
      {
        normalizedInvocationArgs: ["context", "pm-a1b2"],
      },
    );
    expect(unknownCommandName.code).toBe("invalid_command_usage");
  });

  it("keeps generic usage guidance for other commands and other messages", () => {
    const otherCommand = formatCommanderErrorForJson(TOO_MANY, "focus", ALLOWED_TYPES, 2, {
      normalizedInvocationArgs: ["focus", "pm-a1b2", "extra"],
    });
    expect(otherCommand.code).toBe("invalid_command_usage");

    const otherMessage = formatCommanderErrorForJson("error: something else entirely", "context", ALLOWED_TYPES, 2, {
      normalizedInvocationArgs: ["context", "pm-a1b2"],
    });
    expect(otherMessage.code).toBe("invalid_command_usage");
  });
});

describe("buildLinkedTestQuotedRetryCommand", () => {
  it("re-joins shell-split value tokens into a quoted key=value retry", () => {
    expect(
      buildLinkedTestQuotedRetryCommand(["test", "pm-a1b2", "--add", "command", "npm", "test", "--", "parser"]),
    ).toBe('pm test pm-a1b2 --add "command=npm test -- parser"');
    expect(
      buildLinkedTestQuotedRetryCommand(["test", "pm-a1b2", "--remove", "path", "tests/a", "b"]),
    ).toBe('pm test pm-a1b2 --remove "path=tests/a b"');
  });

  it("stops the re-joined value at the next long flag", () => {
    expect(
      buildLinkedTestQuotedRetryCommand(["test", "pm-a1b2", "--add", "command", "npm", "test", "--run"]),
    ).toBe('pm test pm-a1b2 --add "command=npm test" --run');
  });

  it("returns undefined when the shape is not the unquoted linked-test form", () => {
    expect(buildLinkedTestQuotedRetryCommand(undefined)).toBeUndefined();
    expect(buildLinkedTestQuotedRetryCommand(["get", "pm-a1b2", "extra"])).toBeUndefined();
    expect(buildLinkedTestQuotedRetryCommand(["test"])).toBeUndefined();
    expect(buildLinkedTestQuotedRetryCommand(["test", "--add", "command", "a", "b"])).toBeUndefined();
    expect(buildLinkedTestQuotedRetryCommand(["test", "pm-a1b2", "--list"])).toBeUndefined();
    expect(buildLinkedTestQuotedRetryCommand(["test", "pm-a1b2", "--add"])).toBeUndefined();
    expect(buildLinkedTestQuotedRetryCommand(["test", "pm-a1b2", "--add", "scope", "a", "b"])).toBeUndefined();
    expect(buildLinkedTestQuotedRetryCommand(["test", "pm-a1b2", "--add", "command", "single-token"])).toBeUndefined();
  });
});

describe("error-guidance helper edge branches", () => {
  it("covers helper fallbacks used by text and JSON guidance rendering", () => {
    expect(_testOnly.resolveKnownPackageCommandHint("   ")).toBeUndefined();
    expect(_testOnly.renderList("Examples:", [])).toEqual([]);
    expect(_testOnly.dedupeStrings(["a", "a", "b", "a"])).toEqual(["a", "b"]);
    expect(_testOnly.commandExampleForRequiredOption("update", "--status", "Task|Issue")).toEqual([
      'pm update pm-a1b2 --status in_progress --message "Start implementation"',
    ]);

    const existing = ["pm create --help"];
    expect(_testOnly.appendIfMissing(existing, "pm create --help")).toBe(existing);
    expect(_testOnly.appendIfMissing(existing, undefined)).toBe(existing);
  });

  it("covers recovery normalization and commander guidance fallback branches", () => {
    expect(
      _testOnly.normalizeRecoveryPayload({
        fallback_candidates: [{ source: 1, command: null, reason: false } as never],
      }),
    ).toBeUndefined();

    const minimalGuidance = {
      type: "urn:pm-cli:error:minimal",
      code: "minimal",
      title: "Minimal",
      happened: "Minimal happened",
      required: "Minimal required",
    };
    expect(_testOnly.guidanceToJsonEnvelope(minimalGuidance as never, 2)).toEqual({
      type: "urn:pm-cli:error:minimal",
      code: "minimal",
      title: "Minimal",
      detail: "Minimal happened",
      required: "Minimal required",
      exit_code: 2,
    });
    expect(_testOnly.guidanceToClassification(minimalGuidance as never)).toEqual({
      type: "urn:pm-cli:error:minimal",
      code: "minimal",
      title: "Minimal",
      detail: "Minimal happened",
      required: "Minimal required",
    });

    expect(_testOnly.commandExampleForRequiredOption("create", "--type", "")).toEqual([
      'pm create --title "Example title" --description "Example description" --type Task --status open --priority 1 --message "Create item" --create-mode progressive',
    ]);
    expect(_testOnly.commandExampleForRequiredOption(undefined, "--message", "Task|Issue")).toEqual([
      "pm <command> --help",
    ]);

    const missingRequired = formatPmCliErrorForJson("Missing required option --title", 2);
    expect(missingRequired.title).toBe("Missing required option --title");
    const missingRequiredPlural = formatPmCliErrorForJson("Missing required options --title, --description", 2);
    expect(missingRequiredPlural.title).toBe("Missing required options");

    const bareOption = formatCommanderErrorForJson("error: required option 'title' not specified", undefined, "Task|Issue", 2);
    expect(bareOption.title).toBe("Missing required option title");
    const missingTypeOption = formatCommanderErrorForJson(
      "error: required option '--type <value>' not specified",
      undefined,
      "Task|Issue",
      2,
    );
    expect(missingTypeOption.next_steps).toContain(
      'Run "pm create --help --type <value>" for type-aware policy details.',
    );

    const missingArgument = formatCommanderErrorForJson("error: missing required argument 'id'", undefined, "Task|Issue", 2);
    expect(missingArgument.examples).toEqual(["pm <command> --help"]);

    const unknownDoc = formatCommanderErrorForJson("unknown option '--doc'", "update", "Task|Issue", 2);
    expect(unknownDoc.code).toBe("unsupported_update_option");

    const unknownFallback = formatCommanderErrorForJson("unknown option '--bogus'", undefined, "Task|Issue", 2);
    expect(unknownFallback.examples).toContain("pm <command> --help");

    const invalidUsageFallback = formatCommanderErrorForJson("error: random usage failure", undefined, "Task|Issue", 2);
    expect(invalidUsageFallback.examples).toContain("pm <command> --help");

    const contextual = _testOnly.applyPmCliErrorContext(
      {
        type: "urn:pm-cli:error:base",
        code: "base",
        title: "Base",
        happened: "Base happened",
        required: "Base required",
        why: "Base why",
      } as never,
      "Raw",
      { type: " custom.type " } as never,
    );
    expect(contextual.type).toBe("custom.type");

    const missingFallbackRequired = _testOnly.applyPmCliErrorContext(
      {
        type: "urn:pm-cli:error:base",
        code: "base",
        title: "Base",
        happened: "Base happened",
      } as never,
      "",
      { required: 42 } as never,
    );
    expect(missingFallbackRequired.required).toBeUndefined();
  });
});
