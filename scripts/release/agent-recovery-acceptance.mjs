/** Exercise recovery through an installed executable on an isolated nonempty tracker. Trackers: pm-f05lsg, pm-test-measure-prerequisite. */
import assert from "node:assert/strict";
import crossSpawn from "cross-spawn";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/** Run a refused invocation, execute its advertised recovery, and prove authoritative bytes are retained. */
export function verifyInstalledAgentRecovery(command, prefix, options) {
  const run = (args, status = 0) => {
    const result = crossSpawn.sync(command, [...prefix, "--no-extensions", ...args, "--json"], {
      ...options, encoding: "utf8", timeout: 120_000,
    });
    assert.equal(result.status, status, `${args[0]}: ${result.error ?? ""}\n${result.stderr}\n${result.stdout}`);
    const output = status === 0 ? result.stdout : result.stderr;
    // Launchers may prepend notices; the CLI emits one complete JSON document.
    const jsonStart = output.search(/^\s*\{/m);
    assert(jsonStart >= 0, `Missing CLI JSON response: ${output}`);
    return JSON.parse(output.slice(jsonStart));
  };
  const created = run(["create", "--create-mode", "progressive", "--title", "Recovery acceptance", "--type", "Task"]);
  const id = created.id;
  assert.equal(typeof id, "string");
  run(["test", id, "--add-json", JSON.stringify({
    command: "node -e \"require('node:assert/strict').equal(2 + 2, 4)\"",
    scope: "project", note: "Run prerequisite acceptance",
  })]);
  const itemPaths = readdirSync(options.env.PM_PATH, { recursive: true }).filter((entry) =>
    path.basename(entry) === `${id}.toon` || path.basename(entry) === `${id}.md`);
  assert.equal(itemPaths.length, 1, "Created item must have one authoritative document");
  const itemPath = path.join(options.env.PM_PATH, itemPaths[0]);
  const historyPath = path.join(options.env.PM_PATH, "history", `${id}.jsonl`);
  const itemBefore = readFileSync(itemPath);
  const historyBefore = readFileSync(historyPath);
  for (const args of [["--pm-path", path.relative(options.cwd, options.env.PM_PATH), "item", "update", "--help"], ["item", "update", id, "--title", "Must not run"]]) {
    const refusal = run(args, 2);
    assert.equal(refusal.code, "unknown_command");
    assert.deepEqual(refusal.recovery.suggested_retry_args, [
      ...(args[0] === "--pm-path" ? ["--pm-path", options.env.PM_PATH] : []), "--no-extensions", "update", "--help",
    ]);
    assert.equal(run(refusal.recovery.suggested_retry_args).resolved_path, "update");
    assert.deepEqual(readFileSync(itemPath), itemBefore);
    assert.deepEqual(readFileSync(historyPath), historyBefore);
  }
  for (const flag of ["--background", "--acknowledge-linked-tests"]) {
    const prerequisite = run(["test", id, flag, "--measure", "coverage=100,unit=percent"], 2);
    assert.equal(prerequisite.code, "test_measure_requires_run");
    assert.deepEqual(readFileSync(itemPath), itemBefore);
    assert.deepEqual(readFileSync(historyPath), historyBefore);
    if (flag === "--background") {
      assert(prerequisite.recovery.suggested_retry_args.includes("--background"));
      assert(prerequisite.recovery.suggested_retry_args.includes("--run"));
    } else {
      assert.equal(prerequisite.next_steps.length, 3);
      assert(prerequisite.next_steps[1].includes("--acknowledge-linked-tests"));
      assert(prerequisite.next_steps[2].includes("--measure"));
      assert(prerequisite.recovery.suggested_retry_args.includes("--help"));
    }
  }
  const refusal = run(["test", id, "--measure", "coverage=100,unit=percent", "--only-index", "1"], 2);
  assert.equal(refusal.code, "test_measure_requires_run");
  assert.deepEqual(readFileSync(itemPath), itemBefore);
  assert.deepEqual(readFileSync(historyPath), historyBefore);
  const retry = refusal.recovery.suggested_retry_args;
  assert(!retry.includes("--force") && !retry.includes("--allow-untrusted-linked-tests"));
  const recovered = run(retry);
  assert.equal(recovered.run_results[0].status, "passed");
  assert.equal(recovered.run_results.length, 1);
  const help = run(["test", "--help"]);
  assert(help.options.some((option) => option.flags.startsWith("--measure") && option.description.includes("requires --run")));
  return { ok: true, namespace_refusals: 2, measurement_recovery: true, authoritative_bytes_preserved: true };
}
