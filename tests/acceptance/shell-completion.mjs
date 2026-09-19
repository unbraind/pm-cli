/**
 * Execute completion source and choice expansion in native shells (pm-cimph7).
 * Missing interpreters fail this required smoke gate instead of skipping cases.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { runCompletion } from "../../dist/sdk/completion.js";

const unsafe = "safe'; printf INJECTED >&2; : '(printf SUBSTITUTED >&2) $PM_SECRET back\\slash 🚀";
let checked = 0;
for (const mode of ["type", "tag", "flag", "dynamic-type", "dynamic-tag", "status", "fallback-type", "fallback-status"]) {
  const runtime = mode === "flag"
    ? { command_flags: { list: [`--${unsafe}`] } }
    : mode === "fallback-type" ? { item_types: [unsafe] }
      : mode === "fallback-status" ? { statuses: [unsafe] } : {};
  const script = runCompletion("fish", mode === "type" ? [unsafe] : [], mode === "tag" ? [unsafe] : [], false, runtime).script;
  const previous = mode === "flag" ? "--" : `--${mode.replace("dynamic-", "").replace("fallback-", "")} `;
  const result = spawnSync("fish", ["--no-config"], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, PM_TEST_VALUES: unsafe, PM_SECRET: "EXPANDED_SECRET" },
    input: `function pm\n${mode.startsWith("fallback-") ? "return 1" : "printf '%s\\n' \"$PM_TEST_VALUES\""}\nend\n${script}\ncomplete --do-complete 'pm list ${previous}'\n`,
  });
  assert.equal(result.status, 0, `Fish ${mode}: ${result.error ?? result.stderr}`);
  assert.equal(result.stderr, "", `Fish ${mode} must not execute data or emit parser errors`);
  assert.ok(!result.stdout.includes("EXPANDED_SECRET"), `Fish ${mode} must not expand variables`);
  for (const literal of ["🚀", "back\\slash", mode === "flag" ? "$PM-SECRET" : "$PM_SECRET"]) {
    assert.ok(result.stdout.includes(literal), `Fish ${mode} must retain ${literal}`);
  }
  checked += 1;
}

const script = runCompletion("zsh", [unsafe], [unsafe]).script;
const specs = script.split("\n").filter((line) => /--(?:filter-)?(?:type|tags?)\[[^\]]*\]:\(/.test(line));
assert.ok(specs.length > 10, "Exercise every static Zsh type/tag specification");
for (const spec of specs) {
  const result = spawnSync("zsh", ["-f"], {
    encoding: "utf8",
    timeout: 10_000,
    // _arguments evaluates the contents of a parenthesized action as an array.
    input: `args=( ${spec.trim().replace(/\\$/, "")} )\n[[ \${#args[@]} == 1 ]] || exit 2\naction="\${args[1]#*]:}"\neval ws\\=\\( "\${action[2,-2]}" \\)\nprintf '%s ' "\${ws[@]}"\n`,
  });
  assert.equal(result.status, 0, `Zsh: ${result.error ?? result.stderr}`);
  assert.equal(result.stderr, "", "Zsh must not execute choice data");
  assert.equal(result.stdout.trim(), unsafe, "Zsh must preserve literal choices");
  checked += 1;
}
console.log(JSON.stringify({ ok: true, checked, shells: ["fish", "zsh"] }));
