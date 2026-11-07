/**
 * pm-4of199: an extension-created command refuses options it did not declare,
 * and its unknown-option refusal lists only the flags it accepts.
 */
import { describe, expect, it } from "vitest";
import { resolveExtensionCommandRefusalListing } from "../../../../src/cli/runtime/invocation-options.js";
import { _testOnly } from "../../../../src/cli/main.js";
import { validateLooseCommandOptionsWithFlagDefinitions } from "../../../../src/sdk/extension/command-options.js";
import { PmCliError } from "../../../../src/sdk/runtime-primitives.js";

const DECLARED = [{ long: "--status-filter", short: "-s", value_type: "string" }];

function caught(run: () => void): PmCliError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PmCliError);
    return error as PmCliError;
  }
  throw new Error("expected a refusal");
}

describe("pm-4of199 extension command option refusals", () => {
  it("lists declared flags, then the inherited host flags for the command's output kind", () => {
    const plain = resolveExtensionCommandRefusalListing(DECLARED, false);
    expect(plain.definitions).toBe(DECLARED);
    expect(plain.inheritedFlags).toEqual(expect.arrayContaining(["--json", "--pm-path", "--author", "--expect-hash"]));
    for (const excluded of ["--no-extensions", "--output-limit", "--output-cursor"]) {
      expect(plain.inheritedFlags).not.toContain(excluded);
    }
    expect(resolveExtensionCommandRefusalListing([], true).inheritedFlags).toEqual(expect.arrayContaining(["--output-limit", "--output-cursor"]));
  });

  it("refuses every supplied option on a dynamic command without declared flags, naming the first as the flag", () => {
    const descriptor = { command: "demo", arguments: [], flags: [] } as Parameters<typeof _testOnly.validateDynamicExtensionCommandInvocation>[0];
    const error = caught(() => _testOnly.validateDynamicExtensionCommandInvocation(descriptor, [], { zeta: true, bogusFlag: "x" }, []));
    expect(error.message).toMatch(/^Unknown option '--bogus-flag, --zeta' for extension command 'demo'\. This command declares no flags; it accepts only the host flags --json, /u);
    expect(error.context).toMatchObject({
      code: "unknown_option",
      flag: "--bogus-flag",
      nextSteps: ["Run pm contracts --command demo --flags-only --json to list the flags this command accepts."],
    });
    // Omitted and undefined options are not supplied.
    expect(() => _testOnly.validateDynamicExtensionCommandInvocation(descriptor, [], { bogus: undefined }, [])).not.toThrow();
  });

  it("types the declared-flag refusal and lists the listing in place of every validated definition", () => {
    const host = [{ long: "--no-extensions" }, { long: "--json" }];
    const error = caught(() =>
      validateLooseCommandOptionsWithFlagDefinitions({ bogus: true }, [...host, ...DECLARED], "demo", { definitions: DECLARED, inheritedFlags: ["--json"] }),
    );
    expect(error.message).toBe("Unknown option '--bogus' for extension command 'demo'. Expected one of: --status-filter, --json.");
    expect(error.context).toMatchObject({ code: "unknown_option", flag: "--bogus" });
    // Without a listing every validated definition is listed, as core commands an extension augments expect.
    expect(caught(() => validateLooseCommandOptionsWithFlagDefinitions({ bogus: true }, [...host, ...DECLARED], "list")).message).toContain(
      "Expected one of: --no-extensions, --json, --status-filter.",
    );
  });

  it("lists read-output controls on a dynamic command that declares structured read output", () => {
    const descriptor = { command: "demo-read", arguments: [], flags: DECLARED, read_output_declared: true } as Parameters<typeof _testOnly.validateDynamicExtensionCommandInvocation>[0];
    const error = caught(() => _testOnly.validateDynamicExtensionCommandInvocation(descriptor, [], { bogus: true }, DECLARED));
    expect(error.message).toContain("--output-limit");
    expect(error.message).not.toContain("--no-extensions");
  });
});
