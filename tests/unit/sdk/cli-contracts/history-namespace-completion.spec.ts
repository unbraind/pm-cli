/** @module tests/unit/sdk/history-namespace-completion
 * Executes generated shell completion and item-address normalization for native history operations.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  generateBashScript,
  generateFishScript,
  generateZshScript,
} from "../../../../src/sdk/completion.js";
import {
  normalizeItemAddressInvocation,
  supportsItemIdAlias,
} from "../../../../src/sdk/agent/item-addressing.js";
import { normalizeBootstrapInvocation } from "../../../../src/sdk/cli-bootstrap.js";

describe("history namespace completion and item addressing", () => {
  it("completes native Bash operations with the same flags as their legacy aliases", () => {
    const script = generateBashScript();
    /** Send the generated script through stdin so Windows argv limits cannot truncate execution. */
    const complete = (words: string, cword: number): string =>
      execFileSync("bash", ["-s"], {
        input: `${script}\nCOMP_WORDS=(${words}); COMP_CWORD=${cword}; _pm_completion; printf '%s\\n' "\${COMPREPLY[@]}"`,
        encoding: "utf8",
      });
    for (const [leaf, alias, flag] of [
      ["repair", "history-repair", "--salvage-tail"],
      ["redact", "history-redact", "--literal"],
      ["compact", "history-compact", "--all-streams"],
      ["restore", "restore", "--author"],
      ["activity", "activity", "--stream"],
    ]) {
      const native = complete(`pm history ${leaf} --`, 3);
      const legacy = complete(`pm ${alias} --`, 2);
      expect(native).toBe(legacy);
      expect(native.trim().split(/\s+/)).toContain(flag);
    }
    const roots = complete("pm ''", 1).split("\n");
    expect(roots).toContain("history");
    expect(roots).not.toContain("history-repair");
    expect(roots).not.toContain("activity");
  });

  it("exposes native routing in Zsh and Fish scripts", () => {
    for (const [shell, script] of [
      ["zsh", generateZshScript()],
      ["fish", generateFishScript()],
    ] as const) {
      expect(script).toContain(
        shell === "zsh"
          ? 'words=("$words[1]" "history-repair"'
          : "__pm_history_operation history-repair repair",
      );
      expect(script).toContain("redact repair compact activity restore");
    }
    expect(generateFishScript()).toContain(
      "complete -c pm -n '__pm_history_operation activity activity' -l unbounded -d 'Return every matching activity entry'",
    );
  });

  it("keeps restore switches valueless and value flags consuming arguments in Zsh and Fish", () => {
    const zsh = generateZshScript();
    const restore = zsh.slice(zsh.indexOf("        restore)"), zsh.indexOf("        start-task|pause-task)"));
    for (const flag of ["force", "json"]) {
      const line = restore.split("\n").find((entry) => entry.includes(`'--${flag}[`));
      expect(line).toBeDefined();
      expect(line).not.toContain(":value");
    }
    for (const flag of ["author", "message", "pm-path"]) {
      expect(restore.split("\n").find((entry) => entry.includes(`'--${flag}[`))).toContain(":value");
    }
    const fish = generateFishScript().split("\n").filter((line) => line.includes("__pm_history_operation restore restore"));
    for (const flag of ["force", "json"]) {
      expect(fish.find((line) => line.includes(`-l ${flag}`))).toMatch(new RegExp(`-l ${flag}$`));
    }
    for (const flag of ["author", "message", "pm-path"]) {
      expect(fish.find((line) => line.includes(`-l ${flag}`))).toContain(`-l ${flag} -r`);
    }
  });

  it("coalesces native bulk IDs and retains the default item-history address", () => {
    expect(normalizeBootstrapInvocation(["history", "compact", "--ids", "pm-first", "--ids", "pm-second", "--dry_run"]).argv).toEqual([
      "history", "compact", "--ids=pm-first,pm-second", "--dry-run",
    ]);
    expect(normalizeBootstrapInvocation(["history", "pm-example"]).argv).toEqual(["history", "pm-example"]);
    expect(normalizeItemAddressInvocation(["history", "--id=pm-example"])).toMatchObject({
      argv: ["history", "pm-example"], changed: true, conflict: false,
    });
  });

  it("normalizes native item ids around global options and preserves activity filters", () => {
    for (const leaf of ["repair", "redact", "compact", "restore"]) {
      expect(supportsItemIdAlias(`history ${leaf}`)).toBe(true);
      const normalized = normalizeItemAddressInvocation([
        "--json",
        "history",
        "--pm-path",
        "/tmp/tracker",
        leaf,
        "--id",
        "pm-example",
      ]);
      expect(normalized).toMatchObject({
        changed: true,
        conflict: false,
        argv: [
          "--json",
          "history",
          "--pm-path",
          "/tmp/tracker",
          leaf,
          "pm-example",
        ],
      });
    }
    const args = ["history", "--json", "activity", "--id", "pm-example"];
    expect(normalizeItemAddressInvocation(args)).toMatchObject({
      argv: args,
      changed: false,
      conflict: false,
    });
    expect(
      normalizeItemAddressInvocation([
        "history",
        "restore",
        "--id",
        "pm-example",
        "1",
      ]).argv,
    ).toEqual(["history", "restore", "pm-example", "1"]);
  });
});
