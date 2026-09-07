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
import { ACTIVITY_FLAG_CONTRACTS } from "../../../../src/sdk/cli-contracts/flag-contracts.js";
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
      if (leaf === "activity") {
        for (const contract of ACTIVITY_FLAG_CONTRACTS) {
          expect(native.trim().split(/\s+/)).toContain(contract.flag);
        }
      }
    }
    const roots = complete("pm ''", 1).split("\n");
    expect(roots).toContain("history");
    expect(roots).not.toContain("history-repair");
    expect(roots).not.toContain("activity");
  });

  it("exposes native routing and complete activity options in Zsh and Fish scripts", () => {
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
    const zsh = generateZshScript();
    const activity = zsh.slice(zsh.indexOf("        activity)"), zsh.indexOf("        contracts)"));
    const fish = generateFishScript().split("\n").filter((line) => line.includes("__pm_history_operation activity activity"));
    for (const contract of ACTIVITY_FLAG_CONTRACTS) {
      expect(activity).toContain(`${contract.flag}[`);
      expect(fish.some((line) => line.includes(`-l ${contract.flag.slice(2)} `))).toBe(true);
    }
    expect(activity.split("\n").find((line) => line.includes("--stream["))).toContain("]::mode");
    expect(generateFishScript()).toContain(
      "complete -c pm -n '__pm_history_operation activity activity' -l unbounded -d 'Return every matching activity entry'",
    );
  });

  it("offers a value-taking item ID for every history maintenance operation in Zsh and Fish", () => {
    const zsh = generateZshScript();
    const fish = generateFishScript().split("\n");
    for (const leaf of ["redact", "repair", "compact"]) {
      const start = zsh.indexOf(`        history-${leaf})`);
      const operation = zsh.slice(start, zsh.indexOf("          ;;", start));
      expect(operation).toContain("--id[");
      expect(operation.split("\n").find((line) => line.includes("--id["))).toContain(":id");
      expect(fish.find((line) => line.includes(`__pm_history_operation history-${leaf} ${leaf}' -l id `)))
        .toMatch(/ -r$/);
    }
  });

  it("resolves history completion past global prefixes without treating values or later arguments as operations", () => {
    const cases: { words: string[]; includes: string; excludes?: string }[] = [];
    for (const [leaf, alias, flag] of [
      ["redact", "history-redact", "--literal"],
      ["repair", "history-repair", "--salvage-tail"],
      ["compact", "history-compact", "--all-streams"],
      ["activity", "activity", "--stream"],
      ["restore", "restore", "--author"],
    ]) {
      for (const words of [
        ["pm", "history", "--json", leaf, "--"],
        ["pm", "--quiet", "history", "--output-format", "json", leaf, "--"],
        ["pm", "history", "--pm-path", "repair", leaf, "--"],
        ["pm", "history", "--path=redact", leaf, "--"],
        ["pm", "history", "--output_include", "title", leaf, "--"],
        ["pm", "--pm-path", "history", alias, "--"],
        ["pm", alias, "--json", "--"],
      ]) cases.push({ words, includes: flag });
    }
    cases.push(
      { words: ["pm", "history", "--quiet", ""], includes: "redact" },
      { words: ["pm", "--output-format=json", "history", ""], includes: "repair" },
      { words: ["pm", "history", "--pm-path", "redact", "pm-example", "--"], includes: "--verify", excludes: "--literal" },
      { words: ["pm", "history", "pm-example", "redact", "--"], includes: "--verify", excludes: "--literal" },
      { words: ["pm", "history", "--", "redact", "--"], includes: "--verify", excludes: "--literal" },
    );
    const commands = cases.map(({ words }) =>
      `COMP_WORDS=(${words.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(" ")}); COMP_CWORD=${words.length - 1}; _pm_completion; printf '%s ' "\${COMPREPLY[@]}"; printf '\\n'`,
    );
    const rows = execFileSync("bash", ["-s"], {
      input: `${generateBashScript()}\n${commands.join("\n")}`,
      encoding: "utf8",
    }).trim().split("\n");
    expect(rows).toHaveLength(cases.length);
    for (const [index, entry] of cases.entries()) {
      expect(rows[index].trim().split(/\s+/), entry.words.join(" ")).toContain(entry.includes);
      if (entry.excludes) expect(rows[index].trim().split(/\s+/)).not.toContain(entry.excludes);
    }
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
