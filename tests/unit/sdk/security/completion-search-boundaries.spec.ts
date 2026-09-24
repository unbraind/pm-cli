import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCompletion } from "../../../../src/sdk/completion.js";
import { normalizeScoreMap } from "../../../../src/sdk/query/search/lexical.js";
import { itOnPosix } from "../../../helpers/platform.js";

describe("reviewed SDK input boundaries", () => {
  const modes = ["type", "tag", "flag", "dynamic-type", "dynamic-tag", "status", "fallback-type", "fallback-status", "cached-type", "cached-tag", "cached-status"];
  const locales = ["C", process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8"];
  const cases = modes.flatMap((mode) => locales.flatMap((locale) =>
    ["", "🚀", "*", "missing-choice"].map((prefix) => ({ mode, locale, prefix, expected: prefix === "missing-choice" ? [] : [prefix] })),
  ));
  itOnPosix.each(cases)("preserves Bash $mode choices in $locale for prefix '$prefix'", ({ mode, locale, prefix, expected }) => {
    const unsafe = '$(printf INJECTED >&2) `printf BACKTICK >&2` ${PM_SECRET} "quoted" back\\slash 🚀 * single\'quote $(printf${IFS}ACCEPTED>&2)';
    const kind = mode.replace(/^(?:dynamic|fallback|cached)-/, "");
    const runtime = mode === "flag" ? { command_flags: { list: ["--safe", unsafe] } }
      : mode === "fallback-type" ? { item_types: ["Safe", unsafe] }
        : mode === "fallback-status" ? { statuses: ["Safe", unsafe] } : {};
    const script = runCompletion("bash", mode === "type" ? ["Safe", unsafe] : [], mode === "tag" ? ["Safe", unsafe] : [], false, runtime).script;
    const result = spawnSync(process.env.PM_COMPLETION_TEST_BASH ?? "bash", ["--noprofile", "--norc"], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        LC_ALL: locale,
        PM_TEST_VALUES: `Safe ${unsafe}`,
        PM_SECRET: "EXPANDED_SECRET",
        PM_TEST_PREFIX: prefix,
        [`PM_COMPLETION_${kind.toUpperCase()}_CACHE`]: mode.startsWith("cached-") ? `Safe ${unsafe}` : "",
        [`PM_COMPLETION_${kind.toUpperCase()}_CACHE_TS`]: String(Math.floor(Date.now() / 1000)),
      },
      input: `${script}\npm() { ${mode.startsWith("fallback-") || mode.startsWith("cached-") ? "return 1" : "printf '%s\\n' \"$PM_TEST_VALUES\""}; }\nCOMP_WORDS=(pm list '${mode === "flag" ? "list" : `--${kind}`}' "$PM_TEST_PREFIX")\nCOMP_CWORD=3\n_pm_completion\neval "set -- \${COMPREPLY[*]}"\nprintf '%s\\n' "$@"\n`,
    });
    const label = `${locale} ${mode} ${prefix}: ${result.stderr}`;
    expect(result.status, label).toBe(0);
    expect(result.stderr, label).toBe("");
    const choices = result.stdout.trim().split("\n").filter(Boolean);
    if (prefix !== "") {
      expect(choices, label).toEqual(expected);
    } else {
      expect(result.stdout, label).not.toContain("EXPANDED_SECRET");
      expect(choices, label).toEqual(expect.arrayContaining([mode === "flag" ? "--safe" : "Safe", ...unsafe.split(" ")]));
    }
  });

  itOnPosix("decodes quoted and escaped prefixes without evaluating candidates", () => {
    const script = runCompletion("bash", ["Task", "Task'apostrophe", 'Task"double', "Task\\backslash", "Task`literal"]).script;
    for (const [prefix, expected] of [["'Ta", "Task"], ['"Ta', "Task"], ["\\Ta", "Task"], ["'Task'\\''ap", "apostrophe"], ['"Task\\"do', "double"], ["Task\\\\ba", "backslash"], ['"Task\\ba', "backslash"], ["'Task`li", "literal"]]) {
      const result = spawnSync(process.env.PM_COMPLETION_TEST_BASH ?? "bash", ["--noprofile", "--norc"], {
        encoding: "utf8",
        env: { ...process.env, PM_TEST_PREFIX: prefix },
        input: `${script}\n_init_completion() { cur=""; prev=--type; cword=3; }\nCOMP_WORDS=(pm list --type "$PM_TEST_PREFIX")\nCOMP_CWORD=3\nCOMPREPLY=(stale)\n_pm_completion\nprintf '%s\\n' "\${COMPREPLY[@]}"\n`,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(expected);
    }
  });

  itOnPosix("preserves exact bytes after native Bash Tab and Enter in each insertion context", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-completion-pty-"));
    try {
      const source = path.join(root, "completion.bash");
      const sentinel = path.join(root, "executed");
      for (const candidate of [`Task'quote"$PM_SECRET$(touch\${IFS}${sentinel})\`id\`*!🚀`, "Task'", 'Task"', "Task\\"]) {
        await writeFile(source, runCompletion("bash", [candidate]).script);
        for (const prefix of ["'Ta", '"Ta', "\\Ta"]) {
          const input = `bind 'set enable-bracketed-paste off'\nsource '${source}'\npm() { printf 'ARG=<%s>\\n' "$@"; }\npm list --type ${prefix}\t\nexit\n`;
          const bash = process.env.PM_COMPLETION_TEST_BASH ?? "bash";
          const args = process.platform === "darwin"
            ? ["-q", "/dev/null", bash, "--noprofile", "--norc", "-i"]
            : ["-qfec", `${bash} --noprofile --norc -i`, "/dev/null"];
          const result = spawnSync("script", args, {
            encoding: "utf8", input, timeout: 10_000,
            env: { ...process.env, PM_SECRET: "EXPANDED_SECRET" },
          });
          expect(result.status, `${prefix}: ${result.error ?? result.stderr}`).toBe(0);
          expect(result.stdout, prefix).toContain(`ARG=<list>`);
          expect(result.stdout, prefix).toContain(`ARG=<${candidate}>`);
          expect(result.stdout, prefix).not.toContain("ARG=<EXPANDED_SECRET>");
          await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  itOnPosix("keeps Zsh static choice specifications inside their shell argument", () => {
    const unsafe = "safe'; printf INJECTED >&2; : '$(printf SUBSTITUTED >&2)";
    const script = runCompletion("zsh", [unsafe], [unsafe]).script;
    const specs = script.split("\n").filter((line) => /--(?:filter-)?(?:type|tags?)\[[^\]]*\]:\(/.test(line));
    expect(specs.length).toBeGreaterThan(10);
    for (const spec of specs) {
      // These generated arguments use POSIX single-quote syntax, so exercise
      // the source boundary without requiring Zsh on every CI runner.
      const result = spawnSync("bash", ["--noprofile", "--norc"], {
        encoding: "utf8",
        input: `args=( ${spec.trim().replace(/\\$/, "")} )\n[[ \${#args[@]} == 1 ]] || exit 2\naction="\${args[0]#*]:}"\neval "values=( \${action:1:\${#action}-2} )"\nprintf '%s ' "\${values[@]}"\n`,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
      expect(result.stdout.trim()).toBe(unsafe);
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
