/** Exercise the nested-field format boundary using the published hosts from GH-1458. */
import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

/** Require refusal before any authoritative item or history bytes change. */
async function assertRefused(cli, runtime, args, capture, code = "item_format_version_unsupported") {
  const before = await capture();
  assert.throws(() => cli(runtime, args), (error) => {
    const refusal = JSON.parse(String(error.stderr));
    assert.equal(refusal.code, code, `${runtime.version}: ${args.join(" ")}`);
    assert.match(JSON.stringify(refusal), /[Uu]pgrade|installed/u);
    return true;
  });
  assert.deepEqual(await capture(), before, "Older host changed protected evidence");
}

/** Preserve legacy commitments and require coordinated project pins before new-format writes. */
async function prepareLegacyRuntime({ cwd, release, current, cli, id, capture }) {
  const preFormatAdmission = release.version === "2026.10.9";
  if (preFormatAdmission) {
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ devDependencies: { "@unbrained/pm-cli": release.version } }));
    await assertRefused(cli, current, ["test", id, "--update-index", "1", "--set-json", '{"note":"unsafe"}'], capture, "project_runtime_item_format_incompatible");
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ devDependencies: { "@unbrained/pm-cli": current.version } }));
  }
  if (release.version === "2026.10.13") {
    cli(release, ["test", id, "--update-index", "1", "--set-json", '{"timeout_seconds":60}']);
    const legacy = await capture();
    assert.equal(cli(current, ["history", id, "--verify"]).verification.ok, true, "Legacy editor commitments changed");
    assert.deepEqual(await capture(), legacy, "Legacy inspection rewrote evidence");
    const prior = cli(release, ["get", id, "--full"]).item.tests;
    cli(current, ["test", id, "--remove-index", "1"]);
    assert.equal(cli(current, ["get", id, "--full"]).item.pm_format_version, 2, "Removing legacy stamps left retained history readable by an unsafe host");
    cli(current, ["restore", id, "3"]);
    assert.deepEqual(cli(current, ["get", id, "--full"]).item.tests, prior);
    assert.ok((await capture()).history.startsWith(legacy.history));
  }
  return preFormatAdmission;
}

/** Compare persisted JSON values through public SDK consumers and verify older reader refusal. */
async function verifySdkReaders({ cwd, edited, id, pmRoot, current, release, preFormatAdmission, run, trackerEnv, fixtureRoot }) {
  const expectedPath = path.join(cwd, "expected.json");
  await writeFile(expectedPath, JSON.stringify({ tests: edited.tests, pm_format_version: 2 }));
  for (const runtime of preFormatAdmission ? [current] : [release, current]) {
    const consumer = path.join(cwd, `sdk-${runtime.version}`);
    await mkdir(path.join(consumer, "node_modules/@unbrained"), { recursive: true });
    await symlink(runtime.packageRoot, path.join(consumer, "node_modules/@unbrained/pm-cli"));
    const probe = path.join(consumer, "sdk-reader.mjs");
    await copyFile(path.join(fixtureRoot, "sdk-reader.mjs"), probe);
    run(process.execPath, [probe, id, pmRoot, expectedPath, "1", ...(runtime === release ? ["refused"] : [])], consumer, trackerEnv);
  }
}

/** Verify legacy commitments, guarded writes, public SDK reads, restore and current-driver native merges. */
export async function verifyLinkedTestWorkspaces({ root, current, releases, run, fixtureRoot }) {
  const matrix = [];
  for (const release of releases) {
    const cwd = path.join(root, `linked-tests-${release.version}`);
    await mkdir(cwd);
    const pmRoot = path.join(cwd, ".agents/pm");
    const trackerEnv = { PM_PATH: pmRoot, PM_GLOBAL_PATH: path.join(cwd, ".global") };
    const cli = (runtime, args) => JSON.parse(run(process.execPath, [runtime.cli, ...args, "--json", "--no-extensions"], cwd, trackerEnv));
    const git = (...args) => run("git", args, cwd, trackerEnv);
    cli(release, ["init", "--defaults"]);
    const id = cli(release, ["create", "Task", "Nested linked-test compatibility", "--create-mode", "progressive"]).id;
    cli(release, ["test", id, "--add", "command=node --version,note=original"]);
    const itemPath = path.join(pmRoot, "tasks", `${id}.toon`);
    const historyPath = path.join(pmRoot, "history", `${id}.jsonl`);
    const capture = async () => ({ item: await readFile(itemPath, "utf8"), history: await readFile(historyPath, "utf8") });
    const preFormatAdmission = await prepareLegacyRuntime({ cwd, release, current, cli, id, capture });
    const before = await capture();
    cli(current, ["test", id, "--update-index", "1", "--set-json", '{"timeout_seconds":90,"note":"edited"}']);
    const edited = cli(current, ["get", id, "--full"]).item;
    assert.equal(edited.pm_format_version, 2);
    assert.equal(edited.tests[0].timeout_seconds, 90);
    assert.equal(edited.tests[0].note, "edited");
    assert.equal(typeof edited.tests[0].updated_by, "string");
    assert.equal(typeof edited.tests[0].updated_at, "string");
    assert.ok((await capture()).history.startsWith(before.history), "History was re-anchored");
    assert.equal(cli(current, ["history", id, "--verify"]).verification.ok, true);
    for (const args of [...(preFormatAdmission ? [] : [["get", id]]), ["update", id, "--title", "Unsafe"], ["delete", id], ["restore", id, "1"]]) await assertRefused(cli, release, args, capture, preFormatAdmission ? "project_runtime_stale_mutation" : "item_format_version_unsupported");
    await verifySdkReaders({ cwd, edited, id, pmRoot, current, release, preFormatAdmission, run, trackerEnv, fixtureRoot });
    const editedVersion = (await capture()).history.trim().split("\n").length;
    cli(current, ["update", id, "--title", "Ordinary mutation retains nested fields"]);
    assert.deepEqual(cli(current, ["get", id, "--full"]).item.tests, edited.tests);
    cli(current, ["restore", id, "2"]);
    assert.equal(cli(current, ["get", id, "--full"]).item.pm_format_version, 2, "Restore lowered the reader requirement while retaining newer history");
    if (!preFormatAdmission) await assertRefused(cli, release, ["get", id], capture);
    cli(current, ["restore", id, String(editedVersion)]);
    assert.deepEqual(cli(current, ["get", id, "--full"]).item.tests, edited.tests);
    git("init", "--initial-branch=main");
    git("config", "user.email", "compatibility@example.invalid");
    git("config", "user.name", "Compatibility Fixture");
    cli(current, ["merge", "install"]);
    git("add", ".agents", ".gitattributes");
    git("commit", "-m", "Seed guarded linked-test workspace");
    git("checkout", "-b", "peer");
    cli(current, ["update", id, "--description", "Peer description"]);
    git("add", ".agents");
    git("commit", "-m", "Write peer description");
    git("checkout", "main");
    cli(current, ["update", id, "--priority", "1"]);
    git("add", ".agents");
    git("commit", "-m", "Write main priority");
    git("merge", "peer", "--no-edit");
    assert.equal(cli(current, ["merge", "reconcile"]).ok, true);
    const merged = cli(current, ["get", id, "--full"]).item;
    assert.deepEqual(merged.tests, edited.tests);
    assert.equal(merged.pm_format_version, 2);
    assert.equal(merged.description, "Peer description");
    assert.equal(merged.priority, 1);
    assert.equal(cli(current, ["history", id, "--verify"]).verification.ok, true);
    matrix.push({ legacy_writer: release.version, writer: current.version, nested_fields: true, older_refusal: true, admission: preFormatAdmission ? "project_pin_before_write" : "stored_format", sdk: true, restore: true, git_merge: true, history: true });
  }
  return matrix;
}
