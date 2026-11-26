/** Bind declared upstream origins to real annotated tag objects and exact workflow identities. */
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createReleaseProvenance, parseReleaseProvenance, readReleaseTagProvenance, verifyReleaseSourceRun, recordReleasePublicationOrigin } from "../../../../scripts/release/release-tag-provenance.mjs";

const env = { GITHUB_EVENT_NAME: "workflow_dispatch", RELEASE_TRIGGER_ORIGIN: "morning_dispatcher", GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "1", GITHUB_REPOSITORY: "owner/project" };
const source = "a".repeat(40);
const target = "b".repeat(40);
const tag = "v2026.10.10";

describe("tag-carried release provenance", () => {
  it("preserves the explicit origin independently of the downstream tag-push event", () => {
    const record = createReleaseProvenance(tag, source, target, env);
    expect(record).toEqual({ schema: "pm-release-provenance/1", tag, source_sha: source, target_sha: target, event: "workflow_dispatch", trigger_origin: "morning_dispatcher", run_id: 42, run_attempt: 1, repository: "owner/project" });
    expect(parseReleaseProvenance(JSON.stringify(record), tag, target)).toEqual(record);
    expect(createReleaseProvenance(tag, source, target, {}).trigger_origin).toBe("operator");
    expect(createReleaseProvenance(tag, source, target, {}).event).toBe("local");
    for (const [event, origin] of [["schedule", "native_schedule"], ["issues", "blocker_retry"], ["workflow_dispatch", "operator"]]) {
      expect(createReleaseProvenance(tag, source, target, { ...env, GITHUB_EVENT_NAME: event, RELEASE_TRIGGER_ORIGIN: origin }).trigger_origin).toBe(origin);
    }
  });

  it.each([
    { RELEASE_TRIGGER_ORIGIN: "operator", GITHUB_EVENT_NAME: "schedule" },
    { RELEASE_TRIGGER_ORIGIN: "unknown" }, { RELEASE_TRIGGER_ORIGIN: undefined }, { GITHUB_EVENT_NAME: "push" },
    { GITHUB_RUN_ID: "0" }, { GITHUB_RUN_ATTEMPT: "1.5" },
    { GITHUB_REPOSITORY: "invalid" },
  ])("refuses contradictory or malformed source declarations %j", (change) => {
    expect(() => createReleaseProvenance(tag, source, target, { ...env, ...change })).toThrow();
  });

  it("refuses changed tag/target bindings and future schemas while retaining historical unattributed tags", () => {
    const record = createReleaseProvenance(tag, source, target, env);
    for (const text of ["", "legacy tag message", '{"schema":"other"}', "null", '{"schema":42}']) expect(parseReleaseProvenance(text, tag, target)).toBeNull();
    expect(() => createReleaseProvenance("--bad", source, target, env)).toThrow();
    expect(() => createReleaseProvenance(tag, "bad", target, env)).toThrow();
    expect(() => createReleaseProvenance(tag, source, "bad", env)).toThrow();
    expect(() => parseReleaseProvenance('{"schema":"pm-release-provenance/1"', tag, target)).toThrow();
    expect(() => parseReleaseProvenance(JSON.stringify(record), "v2026.10.11", target)).toThrow();
    expect(() => parseReleaseProvenance(JSON.stringify(record), tag, source)).toThrow();
    expect(() => parseReleaseProvenance(JSON.stringify({ ...record, schema: "pm-release-provenance/2" }), tag, target)).toThrow();
    expect(() => parseReleaseProvenance(JSON.stringify({ ...record, run_id: null }), tag, target)).toThrow();
    expect(() => parseReleaseProvenance(JSON.stringify({ ...record, run_id: "42" }), tag, target)).toThrow("identity fields");
  });

  it("requires source-run identity, event, commit, repository and declared origin to agree", () => {
    const record = createReleaseProvenance(tag, source, target, env);
    const run = { id: 42, run_attempt: 1, event: "workflow_dispatch", head_sha: source, head_branch: "trunk", path: ".github/workflows/auto-release.yml", display_title: "Auto Release (morning_dispatcher)", repository: { full_name: "owner/project" } };
    expect(verifyReleaseSourceRun(record, run, "trunk")).toBe(true);
    expect(verifyReleaseSourceRun(record, { ...run, path: ".github/workflows/auto-release.yml@trunk" }, "trunk")).toBe(true);
    for (const change of [{ path: ".github/workflows/unrelated.yml" }, { path: ".github/workflows/unrelated.yml@trunk" }, { path: ".github/workflows/auto-release.yml@main" }, { path: ".github/workflows/auto-release.yml@feature" }, { path: undefined }, { id: 43 }, { run_attempt: 2 }, { event: "schedule" }, { head_sha: target }, { head_branch: "feature" }, { head_branch: "main" }, { head_branch: undefined }, { display_title: "Auto Release (operator)" }, { repository: { full_name: "other/project" } }]) expect(() => verifyReleaseSourceRun(record, { ...run, ...change }, "trunk")).toThrow();
    expect(() => verifyReleaseSourceRun(record, null, "trunk")).toThrow();
    expect(verifyReleaseSourceRun(createReleaseProvenance(tag, source, target, {}), null)).toBe(false);
  });

  it.each(["", null, undefined])("refuses hosted attribution without authoritative default-branch metadata: %s", (defaultBranch) => {
    const record = createReleaseProvenance(tag, source, target, env);
    const run = { id: 42, run_attempt: 1, event: "workflow_dispatch", head_sha: source, head_branch: "trunk", path: ".github/workflows/auto-release.yml", display_title: "Auto Release (morning_dispatcher)", repository: { full_name: "owner/project" } };
    expect(() => verifyReleaseSourceRun(record, run, defaultBranch)).toThrow();
  });

  it("reads native annotated and lightweight tags without executing annotation text", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pm-tag-provenance-"));
    const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/u.test(key))), GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
    const git = (args: string[]) => execFileSync("git", args, { cwd: root, env: gitEnv, encoding: "utf8" }).trim();
    try {
      git(["init", "--initial-branch=main"]);
      git(["commit", "--allow-empty", "-m", "Fixture"]);
      const sha = git(["rev-parse", "HEAD"]);
      const record = createReleaseProvenance(tag, sha, sha, env);
      git(["tag", "-a", "-m", JSON.stringify(record), tag]);
      expect(readReleaseTagProvenance(tag, root)).toMatchObject({ tag, tag_sha: sha, provenance: record, attribution: "declared_tag_provenance" });
      expect(readReleaseTagProvenance(tag, root).tag_object_sha).toBe(git(["rev-parse", `refs/tags/${tag}`]));
      const output = path.join(root, "origin.json");
      const publicationEnv = { RELEASE_TAG: tag, RELEASE_PROVENANCE_OUTPUT: output, GITHUB_EVENT_NAME: "push", GITHUB_REPOSITORY: env.GITHUB_REPOSITORY };
      const binding = { schema: "pm-release-producer-binding/1", tag, tag_sha: sha, tag_object_sha: git(["rev-parse", `refs/tags/${tag}`]), provenance: record };
      let downloadedBinding = JSON.stringify(binding);
      const artifact = { id: 7, name: "release-producer-binding-1", expired: false, size_in_bytes: 1024, workflow_run: { id: 42, head_sha: sha, head_branch: "trunk" } };
      const artifactEndpoint = `repos/${env.GITHUB_REPOSITORY}/actions/runs/42/artifacts?per_page=100`;
      const responses = new Map<string, unknown>([
        [`repos/${env.GITHUB_REPOSITORY}`, { default_branch: "trunk" }],
        [`repos/${env.GITHUB_REPOSITORY}/actions/runs/42/attempts/1`, { id: 42, run_attempt: 1, event: env.GITHUB_EVENT_NAME, head_sha: sha, head_branch: "trunk", path: ".github/workflows/auto-release.yml@trunk", display_title: "Auto Release (morning_dispatcher)", repository: { full_name: env.GITHUB_REPOSITORY } }],
        [artifactEndpoint, [{ total_count: 1, artifacts: [artifact] }]],
      ]);
      const execute = ((command: string, args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding) => {
        if (command !== "gh") return execFileSync(command, args, options);
        if (args[0] === "run") {
          expect(args).toEqual(["run", "download", "42", "--repo", env.GITHUB_REPOSITORY, "--name", artifact.name, "--dir", expect.any(String)]);
          writeFileSync(path.join(args[args.indexOf("--dir") + 1], "producer-binding.json"), downloadedBinding);
          return "";
        }
        const response = responses.get(args[1]);
        if (response === undefined) throw new Error(`Unexpected provider endpoint: ${args[1]}`);
        return JSON.stringify(response);
      }) as typeof execFileSync;
      const pauses: number[] = [];
      const pause = (milliseconds: number) => { pauses.push(milliseconds); };
      const publication = recordReleasePublicationOrigin(publicationEnv, root, execute, pause);
      expect(pauses).toEqual([]);
      // The listing trails a just-finalized upload: a partial inventory and one without the binding are read again.
      const settled = responses.get(artifactEndpoint);
      const trailing = [[{ total_count: 0, artifacts: [] }], [{ total_count: 2, artifacts: [artifact] }], [{ total_count: 1, artifacts: [{ ...artifact, name: "dependency-advisory-42-1" }] }]];
      responses.delete(artifactEndpoint);
      const lagging = ((command: string, args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding) =>
        command === "gh" && args[1] === artifactEndpoint ? JSON.stringify(trailing.shift() ?? settled) : execute(command, args, options)) as typeof execFileSync;
      expect(recordReleasePublicationOrigin(publicationEnv, root, lagging, pause)).toMatchObject({ source_run_verified: true, producer_binding_verified: true });
      expect(pauses).toEqual([1000, 2000, 4000]);
      // The default wait blocks for the declared delay before the second read.
      trailing.push([{ total_count: 0, artifacts: [] }]);
      const started = Date.now();
      expect(recordReleasePublicationOrigin(publicationEnv, root, lagging)).toMatchObject({ producer_binding_verified: true });
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
      responses.set(artifactEndpoint, settled);
      pauses.length = 0;
      expect(publication).toMatchObject({ source_run_verified: true, recovery_origin: null, publication_event: "push", provenance: { trigger_origin: "morning_dispatcher" } });
      expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(publication);
      // The archive of a listed binding can still answer 404: only that answer is downloaded again, each time into a fresh directory.
      const notFound = Object.assign(new Error("Command failed: gh run download"), { stderr: "error downloading release-producer-binding-1: HTTP 404: Not Found (https://api.github.com/repos/o/r/actions/artifacts/7/zip)\n" });
      const downloadFailures: unknown[] = [notFound, notFound];
      const downloadDirectories: string[] = [];
      const trailingDownload = ((command: string, args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding) => {
        if (command !== "gh" || args[0] !== "run") return execute(command, args, options);
        downloadDirectories.push(args[args.indexOf("--dir") + 1]);
        const failure = downloadFailures.shift();
        if (failure !== undefined) throw failure;
        return execute(command, args, options);
      }) as typeof execFileSync;
      expect(recordReleasePublicationOrigin(publicationEnv, root, trailingDownload, pause)).toMatchObject({ producer_binding_verified: true });
      expect(pauses).toEqual([1000, 2000]);
      expect(new Set(downloadDirectories).size).toBe(3);
      // A 404 that outlasts the wait is the provider's own refusal.
      pauses.length = 0;
      downloadFailures.push(...Array.from({ length: 6 }, () => notFound));
      expect(() => recordReleasePublicationOrigin(publicationEnv, root, trailingDownload, pause)).toThrow("Command failed: gh run download");
      expect(pauses).toEqual([1000, 2000, 4000, 8000, 15_000]);
      expect(downloadFailures).toEqual([]);
      expect(JSON.parse(readFileSync(output, "utf8")).producer_binding_verified).toBe(false);
      // The download is addressed by name, so a binding replaced while it was retried is refused (Codex review).
      pauses.length = 0;
      let inventoryReads = 0;
      downloadFailures.push(notFound);
      const replacing = ((command: string, args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding) => {
        if (command === "gh" && args[1] === artifactEndpoint) {
          inventoryReads += 1;
          return JSON.stringify(inventoryReads === 1 ? settled : [{ total_count: 1, artifacts: [{ ...artifact, id: 8 }] }]);
        }
        return trailingDownload(command, args, options);
      }) as typeof execFileSync;
      expect(() => recordReleasePublicationOrigin(publicationEnv, root, replacing, pause)).toThrow("changed while it was downloaded");
      expect(inventoryReads).toBe(2);
      expect(JSON.parse(readFileSync(output, "utf8")).producer_binding_verified).toBe(false);
      // A partial listing after the download is read again within the same bounded wait (Codex round 3).
      pauses.length = 0;
      inventoryReads = 0;
      const trailingAfter = ((command: string, args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding) => {
        if (command === "gh" && args[1] === artifactEndpoint) {
          inventoryReads += 1;
          return JSON.stringify(inventoryReads === 2 ? [{ total_count: 2, artifacts: [artifact] }] : settled);
        }
        return trailingDownload(command, args, options);
      }) as typeof execFileSync;
      expect(recordReleasePublicationOrigin(publicationEnv, root, trailingAfter, pause)).toMatchObject({ producer_binding_verified: true });
      expect(inventoryReads).toBe(3);
      expect(pauses).toEqual([1000]);
      // A replacement visible in a partial listing is refused without waiting (Codex round 4).
      pauses.length = 0;
      inventoryReads = 0;
      const partialReplacement = ((command: string, args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding) => {
        if (command === "gh" && args[1] === artifactEndpoint) {
          inventoryReads += 1;
          return JSON.stringify(inventoryReads === 1 ? settled : [{ total_count: 2, artifacts: [{ ...artifact, id: 8 }] }]);
        }
        return trailingDownload(command, args, options);
      }) as typeof execFileSync;
      expect(() => recordReleasePublicationOrigin(publicationEnv, root, partialReplacement, pause)).toThrow("mismatched release producer binding");
      expect(pauses).toEqual([]);
      // Any other failure, with or without provider output, is refused at once.
      for (const failure of [Object.assign(new Error("Command failed: gh run download"), { stderr: "HTTP 403: Forbidden\n" }), new Error("spawnSync gh ETIMEDOUT"), null]) {
        pauses.length = 0;
        downloadFailures.push(failure);
        expect(() => recordReleasePublicationOrigin(publicationEnv, root, trailingDownload, pause)).toThrow();
        expect(pauses).toEqual([]);
        expect(downloadFailures).toEqual([]);
      }
      git(["commit", "--allow-empty", "-m", "Unrelated descendant"]);
      const copiedTag = "v2026.10.11";
      const copiedTarget = git(["rev-parse", "HEAD"]);
      git(["tag", "-a", "-m", JSON.stringify(createReleaseProvenance(copiedTag, sha, copiedTarget, env)), copiedTag]);
      expect(readReleaseTagProvenance(copiedTag, root).tag_sha).toBe(copiedTarget);
      expect(() => recordReleasePublicationOrigin({ ...publicationEnv, RELEASE_TAG: copiedTag }, root, execute, pause)).toThrow("producer binding");
      for (const artifacts of [[], [artifact, artifact], [{ ...artifact, expired: true }], [{ ...artifact, id: undefined }], [{ ...artifact, id: 0 }], [{ ...artifact, size_in_bytes: 4097 }], [{ ...artifact, workflow_run: { ...artifact.workflow_run, id: 43 } }], [{ ...artifact, workflow_run: { ...artifact.workflow_run, head_sha: source } }]]) {
        responses.set(artifactEndpoint, [{ total_count: artifacts.length, artifacts }]);
        pauses.length = 0;
        expect(() => recordReleasePublicationOrigin(publicationEnv, root, execute, pause)).toThrow("producer binding");
        // Only an inventory that lists no binding yet is read again; a duplicate or invalid binding is refused at once.
        expect(pauses).toEqual(artifacts.length === 0 ? [1000, 2000, 4000, 8000, 15_000] : []);
        if (artifacts.length > 0) {
          // The same holds while the listing is still partial: a visible defect is never waited out.
          responses.set(artifactEndpoint, [{ total_count: artifacts.length + 1, artifacts }]);
          expect(() => recordReleasePublicationOrigin(publicationEnv, root, execute, pause)).toThrow("producer binding");
          expect(pauses).toEqual([]);
        }
        expect(JSON.parse(readFileSync(output, "utf8")).source_run_verified).toBe(false);
      }
      responses.set(artifactEndpoint, [{ total_count: 1, artifacts: artifact }]);
      expect(() => recordReleasePublicationOrigin(publicationEnv, root, execute, pause)).toThrow("Invalid release producer binding inventory");
      // A listing without a numeric count is malformed, not partial: it is refused without a wait.
      pauses.length = 0;
      responses.set(artifactEndpoint, [{ artifacts: [artifact] }]);
      expect(() => recordReleasePublicationOrigin(publicationEnv, root, execute, pause)).toThrow("Invalid release producer binding inventory");
      expect(pauses).toEqual([]);
      expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({ source_run_verified: false, producer_binding_verified: false });
      responses.set(artifactEndpoint, [{ total_count: 1, artifacts: [artifact] }]);
      downloadedBinding = JSON.stringify({ ...binding, extension: "x".repeat(4097) });
      expect(() => recordReleasePublicationOrigin(publicationEnv, root, execute, pause)).toThrow("Invalid release producer binding file");
      expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({ source_run_verified: false, producer_binding_verified: false });
      downloadedBinding = JSON.stringify(binding);
      expect(() => recordReleasePublicationOrigin({ ...publicationEnv, GITHUB_REPOSITORY: "other/project" }, root, execute, pause)).toThrow("repository mismatch");
      git(["tag", "v2026.10.9"]);
      expect(readReleaseTagProvenance("v2026.10.9", root)).toMatchObject({ provenance: null, attribution: "legacy_unattributed" });
      expect(() => recordReleasePublicationOrigin({ ...publicationEnv, RELEASE_TAG: "v2026.10.9", GITHUB_EVENT_NAME: "workflow_dispatch", RELEASE_RECOVERY_TRIGGER_ORIGIN: "operator" }, root)).toThrow("historical tag object");
      git(["tag", "-a", "-m", JSON.stringify(createReleaseProvenance("v2026.10.6", sha, sha, {})), "v2026.10.6", sha]);
      expect(() => recordReleasePublicationOrigin({ ...publicationEnv, RELEASE_TAG: "v2026.10.6" }, root)).toThrow("hosted producer");
      git(["tag", "-a", "-m", "legacy note", "v2026.10.8"]);
      expect(readReleaseTagProvenance("v2026.10.8", root).provenance).toBeNull();
      expect(() => recordReleasePublicationOrigin({ ...publicationEnv, RELEASE_TAG: "v2026.10.8" }, root)).toThrow("historical tag object");
      expect(() => readReleaseTagProvenance("--bad", root)).toThrow();
      expect(() => readReleaseTagProvenance("v2026.10.7", root)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovers the exact captured historical Git object and refuses changed tags or repositories", () => {
    const fixture = JSON.parse(readFileSync(new URL("../../../fixtures/release-ledgers/legacy-tag-commit.json", import.meta.url), "utf8")) as { tag: string; object_sha: string; commit: string };
    const root = mkdtempSync(path.join(tmpdir(), "pm-legacy-tag-"));
    const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/u.test(key))), GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
    const git = (args: string[]) => execFileSync("git", args, { cwd: root, env: gitEnv, encoding: "utf8" }).trim();
    try {
      git(["init", "--initial-branch=main"]);
      const sha = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], { cwd: root, env: gitEnv, encoding: "utf8", input: fixture.commit }).trim();
      expect(sha).toBe(fixture.object_sha);
      git(["tag", fixture.tag, sha]);
      const output = path.join(root, "origin.json");
      const publicationEnv = { RELEASE_TAG: fixture.tag, RELEASE_PROVENANCE_OUTPUT: output, GITHUB_EVENT_NAME: "workflow_dispatch", RELEASE_RECOVERY_TRIGGER_ORIGIN: "operator", GITHUB_REPOSITORY: "unbraind/pm-cli" };
      const report = recordReleasePublicationOrigin(publicationEnv, root);
      expect(report).toMatchObject({ attribution: "legacy_unattributed", provenance: null, source_run_verified: false, tag_object_sha: fixture.object_sha, recovery_origin: "operator" });
      expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(report);
      expect(() => recordReleasePublicationOrigin({ ...publicationEnv, GITHUB_REPOSITORY: "other/project" }, root)).toThrow("historical tag object");
      git(["tag", "-d", fixture.tag]);
      git(["tag", "-a", fixture.tag, sha, "-m", "new unrelated annotation"]);
      expect(() => recordReleasePublicationOrigin({ ...publicationEnv, GITHUB_EVENT_NAME: "push" }, root)).toThrow("historical tag object");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
