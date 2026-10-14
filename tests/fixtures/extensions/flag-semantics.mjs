/** Independent synthetic extension grammar oracle shared by source and exact-artifact acceptance. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Synthetic echo fixture; expected behavior below never calls the production flag normalizer. */
export const EXTENSION_FLAG_FIXTURE = `export default { activate(api) {
  const flags = [
    { long: "--enabled", short: "-e", type: "bool", default: true },
    { long: "--truth", value_type: "boolean", default: true },
    { long: "--maybe [label]", short: "-m" },
    { long: "--repo <project>", short: "-r", type: "string" },
    { long: "--count=<number>", type: "number" },
    { long: "--labels", short: "-l", value_type: "string", list: true },
    { long: "--repeat", type: "string", repeatable: true },
    { long: "--silent" }
  ];
  const run = context => ({ options: context.options, args: context.args });
  api.registerCommand({ name: "semantic probe", action: "semantic-probe", flags, run });
  api.registerCommand({ name: "semantic-probe", action: "semantic-probe", flags, run });
  api.registerCommand({ name: "semantic presence", flags: [{ long: "--maybe [label]", required: true }], run });
} };`;

/** Install the harmless fixture in an already isolated tracker. */
export function writeExtensionFlagFixture(pmRoot) {
  const directory = path.join(pmRoot, "extensions", "semantic-probe");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({
    name: "semantic-probe", version: "1.0.0", entry: "index.mjs", capabilities: ["commands", "schema"],
  }));
  writeFileSync(path.join(directory, "index.mjs"), EXTENSION_FLAG_FIXTURE);
}

/** Compare literal dispatch outcomes and independently observed help arity with public SDK contracts. */
export function verifyExtensionFlagFixture(run, contracts, verifyParity) {
  const cases = [
    ["bool-spaced-false", ["--enabled", "false"], { enabled: false, truth: true }, []],
    ["bool-spaced-zero", ["--enabled", "0"], { enabled: false, truth: true }, []],
    ["bool-spaced-true", ["-e", "true"], { enabled: true, truth: true }, []],
    ["bool-spaced-one", ["-e", "1"], { enabled: true, truth: true }, []],
    ["bool-equals", ["--enabled=false"], { enabled: false, truth: true }, []],
    ["bool-negated", ["--no-enabled"], { enabled: false, truth: true }, ["--no-enabled"]],
    ["canonical-positionals", ["--truth", "false", "operand"], { enabled: true, truth: true }, ["false", "operand"]],
    ["canonical-equals", ["--truth=false"], { enabled: true, truth: false }, ["--truth=false"]],
    ["optional-bare", ["--maybe"], { enabled: true, truth: true, maybe: true }, []],
    ["optional-value", ["-m", "label"], { enabled: true, truth: true, maybe: "label" }, []],
    ["required-value", ["-r", "example/project", "--count=7"], { enabled: true, truth: true, repo: "example/project", count: 7 }, []],
    ["list-order", ["-l", "a,b", "--labels", "c", "--repeat", "x", "--repeat", "y"], { enabled: true, truth: true, labels: ["a", "b", "c"], repeat: ["x", "y"] }, []],
    ["switch-positionals", ["--silent", "operand"], { enabled: true, truth: true, silent: true }, ["operand"]],
    ["terminator", ["--enabled", "false", "--", "false"], { enabled: false, truth: true }, ["false"]],
  ];
  const executed = [];
  for (const command of [["semantic", "probe"], ["semantic-probe"]]) {
    for (const [id, args, options, remaining] of cases) {
      const label = `${command.join(" ")}:${id}`;
      const result = run([...command, "--json", ...args]);
      assert.equal(result.status, 0, `${label}: ${result.stderr}`);
      assert.deepEqual(JSON.parse(result.stdout), { options, args: remaining }, label);
      executed.push(label);
    }
    for (const args of [["--enabled"], ["--repo"], ["--unknown"]]) {
      const result = run([...command, ...args, "--json"]);
      assert.equal(result.status, 2, `refusal:${args.join(" ")}`);
      assert(!result.stdout.includes('"options"'), "A refused invocation must not reach the echo handler");
      executed.push(`${command.join(" ")}:refusal:${args.join(" ")}`);
    }
    const name = command.join(" ");
    const help = JSON.parse(run([...command, "--help", "--json"]).stdout);
    const rows = contracts.command_flags.find((row) => row.command === name)?.flag_invocations;
    assert(rows?.length === 8, `${name}: missing or extra extension contract flags`);
    const observations = help.options.filter((option) => rows.some((row) => row.flag === option.long)).map((option) => ({
      command: name, flag: option.long, takes_value: option.takes_value, value_required: option.value_required,
      // This verifier owns arity. Independent dispatch cases above own accumulation and ordering.
      repeatable: rows.find((row) => row.flag === option.long).repeatable,
    }));
    assert.equal(observations.length, 8, `${name}: missing or duplicate executable options`);
    assert.deepEqual(verifyParity(name, rows, observations).findings, [], `${name}: invocation parity`);
    for (const [flag, takes, required] of [["--enabled", true, true], ["--truth", false, false], ["--maybe", true, false], ["--repo", true, true], ["--silent", false, false]]) {
      const row = rows.find((candidate) => candidate.flag === flag);
      assert.deepEqual([row.takes_value, row.value_required], [takes, required], `${name}:${flag}:literal arity`);
    }
    executed.push(`${name}:help-sdk-parity`);
  }
  const presence = run(["semantic", "presence", "--maybe", "--json"]);
  assert.equal(presence.status, 0, presence.stderr);
  assert.deepEqual(JSON.parse(presence.stdout), { options: { maybe: true }, args: [] });
  assert.equal(run(["semantic", "presence", "--json"]).status, 2, "Flag presence remains required while its value is optional");
  executed.push("required-presence-optional-value");
  assert(executed.length > 0);
  return { ok: true, case_count: executed.length, executed_cases: executed };
}

/** Prove structured SDK callers preserve explicit false, optional presence, ordered lists and positional operands. */
export async function verifySdkExtensionFlagFixture(client) {
  const options = { enabled: false, truth: false, maybe: true, labels: ["first", "second"] };
  const result = await client.run("semantic-probe", { options, args: ["operand"] });
  assert.deepEqual(result, { options: { enabled: false, truth: false, maybe: true, labels: ["first", "second"] }, args: ["operand"] }, "public-sdk-extension-dispatch");
}

/** Exercise resolved public exports and the manifest-declared executable inside the disposable consumer. */
export async function runExtensionFlagConsumer(root, execute) {
  const installed = createRequire(path.join(root, "package.json"));
  const runtimePath = installed.resolve("@unbrained/pm-cli/sdk/runtime");
  const contractsPath = installed.resolve("@unbrained/pm-cli/sdk/contracts");
  const { getContracts, PmClient } = await import(pathToFileURL(runtimePath).href);
  const { verifyCliFlagInvocationParity } = await import(pathToFileURL(contractsPath).href);
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const cli = path.resolve(root, manifest.bin.pm);
  const run = (args) => execute(process.execPath, [cli, ...args], { env: process.env });
  const initialized = run(["init", "--defaults", "--json"]);
  assert.equal(initialized.status, 0, initialized.stderr);
  writeExtensionFlagFixture(process.env.PM_PATH);
  const surfaces = await Promise.all(["semantic probe", "semantic-probe"].map((command) =>
    getContracts({ pmRoot: process.env.PM_PATH, full: true, flagsOnly: true, command })));
  const contracts = { command_flags: surfaces.flatMap((surface) => surface.command_flags) };
  const report = verifyExtensionFlagFixture(run, contracts, verifyCliFlagInvocationParity);
  await verifySdkExtensionFlagFixture(new PmClient({ pmRoot: process.env.PM_PATH }));
  report.executed_cases.push("public-sdk-extension-dispatch");
  report.case_count += 1;
  return { ...report, package: manifest.name, version: manifest.version,
    runtime: { name: process.versions.bun ? "bun" : "node", version: process.versions.bun ?? process.version, platform: process.platform, arch: process.arch },
    resolved_entrypoints: { cli: path.relative(root, cli), sdk: path.relative(root, runtimePath), contracts: path.relative(root, contractsPath) },
    fixture_sha256: createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex") };
}

