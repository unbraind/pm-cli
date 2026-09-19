import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runCompletion } from "../../../../src/sdk/completion.js";
import { normalizeScoreMap } from "../../../../src/sdk/query/search/lexical.js";
import { itOnPosix } from "../../../helpers/platform.js";

describe("reviewed SDK input boundaries", () => {
  itOnPosix("keeps static and dynamic Bash completion values inert", () => {
    const unsafe = '$(printf INJECTED >&2) `printf BACKTICK >&2` ${PM_SECRET} "quoted" back\\slash';
    for (const mode of ["type", "tag", "flag", "dynamic-type", "dynamic-tag", "status"]) {
      const script = runCompletion(
        "bash",
        mode === "type" ? ["Safe", unsafe] : [],
        mode === "tag" ? ["Safe", unsafe] : [],
        false,
        mode === "flag" ? { command_flags: { list: ["--safe", unsafe] } } : {},
      ).script;
      const previous = mode === "flag" ? "list" : `--${mode.replace("dynamic-", "")}`;
      const result = spawnSync("bash", ["--noprofile", "--norc"], {
        encoding: "utf8",
        env: { ...process.env, PM_TEST_VALUES: `Safe ${unsafe}`, PM_SECRET: "EXPANDED_SECRET" },
        input: `${script}\npm() { printf '%s\\n' "$PM_TEST_VALUES"; }\nCOMP_WORDS=(pm list '${previous}' '')\nCOMP_CWORD=3\n_pm_completion\nprintf '%s\\n' "\${COMPREPLY[@]}"\n`,
      });
      expect(result.status, mode).toBe(0);
      expect(result.stderr, mode).toBe("");
      expect(result.stdout, mode).not.toContain("EXPANDED_SECRET");
      expect(result.stdout, mode).toContain(mode === "flag" ? "--safe" : "Safe");
      expect(result.stdout, mode).toContain("${PM_SECRET}");
      expect(result.stdout, mode).toContain('"quoted"');
      expect(result.stdout, mode).toContain("back\\slash");
    }
  });

  it("normalizes large score maps without an argument-count limit", () => {
    const scores = new Map<string, number>();
    for (let index = 0; index < 200_000; index += 1) scores.set(String(index), index - 100_000);
    const normalized = normalizeScoreMap(scores);
    expect(normalized.size).toBe(scores.size);
    expect(normalized.get("0")).toBe(0);
    expect(normalized.get("199999")).toBe(1);
    expect(normalized.get("100000")).toBeCloseTo(100_000 / 199_999);
  });
});
