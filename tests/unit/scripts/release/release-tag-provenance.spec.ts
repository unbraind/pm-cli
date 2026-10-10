/** Bind declared upstream origins to real annotated tag objects and exact workflow identities. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    { RELEASE_TRIGGER_ORIGIN: "unknown" }, { GITHUB_EVENT_NAME: "push" },
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
    const run = { id: 42, run_attempt: 1, event: "workflow_dispatch", head_sha: source, path: ".github/workflows/auto-release.yml", display_title: "Auto Release (morning_dispatcher)", repository: { full_name: "owner/project" } };
    expect(verifyReleaseSourceRun(record, run)).toBe(true);
    for (const change of [{ path: ".github/workflows/unrelated.yml" }, { id: 43 }, { run_attempt: 2 }, { event: "schedule" }, { head_sha: target }, { display_title: "Auto Release (operator)" }, { repository: { full_name: "other/project" } }]) expect(() => verifyReleaseSourceRun(record, { ...run, ...change })).toThrow();
    expect(() => verifyReleaseSourceRun(record, null)).toThrow();
    expect(verifyReleaseSourceRun(createReleaseProvenance(tag, source, target, {}), null)).toBe(false);
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
      const execute: typeof execFileSync = ((command, args, options) => command === "gh" ? JSON.stringify({ id: 42, run_attempt: 1, event: env.GITHUB_EVENT_NAME, head_sha: sha, path: ".github/workflows/auto-release.yml", display_title: "Auto Release (morning_dispatcher)", repository: { full_name: env.GITHUB_REPOSITORY } }) : execFileSync(command, args, options)) as typeof execFileSync;
      const publication = recordReleasePublicationOrigin(publicationEnv, root, execute);
      expect(publication).toMatchObject({ source_run_verified: true, recovery_origin: null, publication_event: "push", provenance: { trigger_origin: "morning_dispatcher" } });
      expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(publication);
      expect(() => recordReleasePublicationOrigin({ ...publicationEnv, GITHUB_REPOSITORY: "other/project" }, root, execute)).toThrow("repository mismatch");
      git(["tag", "v2026.10.9"]);
      expect(readReleaseTagProvenance("v2026.10.9", root)).toMatchObject({ provenance: null, attribution: "legacy_unattributed" });
      expect(recordReleasePublicationOrigin({ ...publicationEnv, RELEASE_TAG: "v2026.10.9", GITHUB_EVENT_NAME: "workflow_dispatch", RELEASE_RECOVERY_TRIGGER_ORIGIN: "operator" }, root).recovery_origin).toBe("operator");
      git(["tag", "-a", "-m", JSON.stringify(createReleaseProvenance("v2026.10.6", sha, sha, {})), "v2026.10.6"]);
      expect(recordReleasePublicationOrigin({ ...publicationEnv, RELEASE_TAG: "v2026.10.6" }, root).source_run_verified).toBe(false);
      git(["tag", "-a", "-m", "legacy note", "v2026.10.8"]);
      expect(readReleaseTagProvenance("v2026.10.8", root).provenance).toBeNull();
      expect(() => readReleaseTagProvenance("--bad", root)).toThrow();
      expect(() => readReleaseTagProvenance("v2026.10.7", root)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
