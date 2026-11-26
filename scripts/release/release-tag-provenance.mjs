/** Preserve upstream release declarations in content-addressed Git tag objects. */
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerTempCleanup } from "../temp-lifecycle.mjs";

/** Validate hosted run identity, preserving an explicit absence for local preparation. */
function workflowIdentity(event, env) {
  if (event === "local") return { run_id: null, run_attempt: null, repository: null };
  const id = Number(env.GITHUB_RUN_ID);
  const attempt = Number(env.GITHUB_RUN_ATTEMPT);
  const repository = env.GITHUB_REPOSITORY;
  if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(attempt) || attempt < 1 || typeof repository !== "string" || !/^[\w.-]+\/[\w.-]+$/u.test(repository)) throw new Error("Invalid release provenance workflow identity.");
  return { run_id: id, run_attempt: attempt, repository };
}

/** Build a bounded provenance record, refusing contradictory event/origin declarations. */
export function createReleaseProvenance(tag, sourceSha, targetSha, env = process.env) {
  if (!/^v\d{4}\.\d{1,2}\.\d{1,2}(?:-\d+)?$/u.test(tag) || !/^[a-f\d]{40}$/u.test(sourceSha) || !/^[a-f\d]{40}$/u.test(targetSha)) throw new Error("Invalid release provenance tag or commit identity.");
  const event = env.GITHUB_EVENT_NAME ?? "local";
  const origin = env.RELEASE_TRIGGER_ORIGIN ?? (event === "local" ? "operator" : undefined);
  const allowed = { schedule: ["native_schedule"], issues: ["blocker_retry"], workflow_dispatch: ["morning_dispatcher", "operator"], local: ["operator"] };
  if (!allowed[event]?.includes(origin)) throw new Error("Invalid release provenance trigger origin.");
  return { schema: "pm-release-provenance/1", tag, source_sha: sourceSha, target_sha: targetSha, event, trigger_origin: origin, ...workflowIdentity(event, env) };
}

/** Parse only the supported data schema and bind it to the actual tag and peeled commit. */
export function parseReleaseProvenance(message, tag, targetSha) {
  let value;
  try { value = JSON.parse(message); } catch (error) {
    if (message.includes("pm-release-provenance/")) throw error;
    return null;
  }
  if (typeof value?.schema !== "string" || !value.schema.startsWith("pm-release-provenance/")) return null;
  if (value.schema !== "pm-release-provenance/1" || value.tag !== tag || value.target_sha !== targetSha) throw new Error("Release provenance schema or tag binding mismatch.");
  const record = createReleaseProvenance(tag, value.source_sha, targetSha, { GITHUB_EVENT_NAME: value.event, RELEASE_TRIGGER_ORIGIN: value.trigger_origin, GITHUB_RUN_ID: String(value.run_id), GITHUB_RUN_ATTEMPT: String(value.run_attempt), GITHUB_REPOSITORY: value.repository });
  if (JSON.stringify(record) !== JSON.stringify(Object.fromEntries(Object.keys(record).map((key) => [key, value[key]])))) throw new Error("Invalid release provenance identity fields.");
  return record;
}

/** Read tag objects as data; lightweight and unrelated legacy annotations remain unattributed. */
export function readReleaseTagProvenance(tag, cwd = process.cwd(), execute = execFileSync) {
  if (!/^v\d{4}\.\d{1,2}\.\d{1,2}(?:-\d+)?$/u.test(tag)) throw new Error("Invalid release tag.");
  const options = { cwd, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/u.test(key))), encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 };
  const ref = `refs/tags/${tag}`;
  const sha = execute("git", ["--no-replace-objects", "rev-parse", "--verify", `${ref}^{commit}`], options).trim();
  const objectSha = execute("git", ["--no-replace-objects", "rev-parse", "--verify", ref], options).trim();
  const type = execute("git", ["--no-replace-objects", "cat-file", "-t", ref], options).trim();
  const provenance = type === "tag" ? parseReleaseProvenance(execute("git", ["--no-replace-objects", "for-each-ref", "--format=%(contents)", ref], options), tag, sha) : null;
  if (provenance !== null) execute("git", ["--no-replace-objects", "merge-base", "--is-ancestor", provenance.source_sha, sha], options);
  return { tag, tag_sha: sha, tag_object_sha: objectSha, attribution: provenance === null ? "legacy_unattributed" : "declared_tag_provenance", provenance };
}

/** Bind a source run to its original identity and the repository's authoritative default branch. */
export function verifyReleaseSourceRun(provenance, run, defaultBranch) {
  if (provenance.event === "local") return false;
  if (typeof defaultBranch !== "string" || defaultBranch.length === 0 || run?.head_branch !== defaultBranch || ![".github/workflows/auto-release.yml", `.github/workflows/auto-release.yml@${defaultBranch}`].includes(run.path) || run.id !== provenance.run_id || run.run_attempt !== provenance.run_attempt || run.event !== provenance.event || run.head_sha !== provenance.source_sha || run.repository?.full_name !== provenance.repository || run.display_title !== `Auto Release (${provenance.trigger_origin})`) throw new Error("Release source-run provenance mismatch.");
  return true;
}

/** Whether one listed artifact is a bounded, unexpired binding of exactly the declared producer run. */
function isDeclaredProducerBinding(artifact, source, defaultBranch) {
  return Number.isSafeInteger(artifact.id) && artifact.id >= 1 && artifact.expired === false && Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes >= 1 && artifact.size_in_bytes <= 4096 && artifact.workflow_run?.id === source.run_id && artifact.workflow_run.head_sha === source.source_sha && artifact.workflow_run.head_branch === defaultBranch;
}

/** The inventory's artifacts and this attempt's bindings among them, or a refusal of a malformed listing. */
function producerBindingInventory(pages, source) {
  if (!Array.isArray(pages) || pages.length === 0 || pages.some((page) => !Array.isArray(page.artifacts)) || !Number.isSafeInteger(pages[0].total_count)) throw new Error("Invalid release producer binding inventory.");
  const artifacts = pages.flatMap((page) => page.artifacts);
  return { complete: artifacts.length === pages[0].total_count, matching: artifacts.filter((artifact) => artifact.name === `release-producer-binding-${source.run_attempt}`) };
}

/** Select one bounded immutable artifact from the complete verified producer inventory. */
function selectProducerBindingArtifact(pages, source, defaultBranch) {
  const { complete, matching } = producerBindingInventory(pages, source);
  if (!complete || matching.length !== 1 || !isDeclaredProducerBinding(matching[0], source, defaultBranch)) throw new Error("Missing, ambiguous or mismatched release producer binding.");
  return matching[0];
}

/** Waits before each repeated provider read; the artifacts API trails a just-finalized upload. */
const PROVIDER_REREAD_DELAYS_MS = [1000, 2000, 4000, 8000, 15_000];

/** Block this synchronous gate without spinning. */
function pauseSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** One read of the producer run's artifact inventory, every page. */
function readInventoryPages(execute, options, source) {
  return JSON.parse(execute("gh", ["api", `repos/${source.repository}/actions/runs/${source.run_id}/artifacts?per_page=100`, "--paginate", "--slurp"], options));
}

/**
 * Read the producer run's artifact inventory. The listing trails an upload finalized moments
 * earlier, so an inventory that does not yet list this attempt's binding, or lists one valid
 * binding while still partial, is read again within a bounded wait. A duplicate or invalid
 * binding visible in any read ends the wait at once, and the last inventory read is judged
 * exactly as a single read was.
 */
function readProducerBindingInventory(execute, options, source, defaultBranch, pause) {
  const read = () => readInventoryPages(execute, options, source);
  const trailing = (pages) => {
    const { complete, matching } = producerBindingInventory(pages, source);
    if (matching.length === 0) return true;
    return !complete && matching.length === 1 && isDeclaredProducerBinding(matching[0], source, defaultBranch);
  };
  let pages = read();
  for (const delay of PROVIDER_REREAD_DELAYS_MS) {
    if (!trailing(pages)) break;
    pause(delay);
    pages = read();
  }
  return pages;
}

/** Whether a failed provider command reported that the requested resource does not exist (yet). */
function isProviderNotFound(error) {
  return /\bHTTP 404\b/u.test(String(error?.stderr ?? ""));
}

/**
 * Download the selected binding. Its archive can still answer 404 moments after a complete
 * inventory lists it, so only a 404 is retried within the bounded wait, each attempt into a fresh
 * directory; any other failure, or a 404 that outlasts the wait, is the provider's own refusal.
 */
function downloadProducerBinding(execute, options, source, artifact, directory, pause) {
  for (let attempt = 0; ; attempt += 1) {
    const target = path.join(directory, String(attempt));
    mkdirSync(target);
    try {
      execute("gh", ["run", "download", String(source.run_id), "--repo", source.repository, "--name", artifact.name, "--dir", target], options);
      return target;
    } catch (error) {
      if (attempt === PROVIDER_REREAD_DELAYS_MS.length || !isProviderNotFound(error)) throw error;
      pause(PROVIDER_REREAD_DELAYS_MS[attempt]);
    }
  }
}

/** Validate a bounded regular producer document against every actual Git identity and declaration. */
function verifyProducerBindingFile(directory, report) {
  const file = path.join(directory, "producer-binding.json");
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > 4096) throw new Error("Invalid release producer binding file.");
  const binding = JSON.parse(readFileSync(file, "utf8"));
  if (binding.schema !== "pm-release-producer-binding/1" || binding.tag !== report.tag || binding.tag_sha !== report.tag_sha || binding.tag_object_sha !== report.tag_object_sha || JSON.stringify(parseReleaseProvenance(JSON.stringify(binding.provenance), report.tag, report.tag_sha)) !== JSON.stringify(report.provenance)) throw new Error("Release producer binding does not match the actual tag object.");
}

/** Admit exact historical objects or hosted producers independently bound to the actual tag object. */
export function recordReleasePublicationOrigin(env = process.env, cwd = process.cwd(), execute = execFileSync, pause = pauseSync) {
  const report = { schema: "pm-release-publication-origin/1", ...readReleaseTagProvenance(env.RELEASE_TAG, cwd, execute), publication_event: env.GITHUB_EVENT_NAME, recovery_origin: env.RELEASE_RECOVERY_TRIGGER_ORIGIN || null, source_run_verified: false, producer_binding_verified: false };
  writeFileSync(env.RELEASE_PROVENANCE_OUTPUT, `${JSON.stringify(report)}\n`);
  if (report.provenance === null) {
    const historical = JSON.parse(readFileSync(new URL("../../config/release-tag-legacy.json", import.meta.url), "utf8"));
    if (historical.repository !== env.GITHUB_REPOSITORY || historical.tag_objects[report.tag] !== report.tag_object_sha) throw new Error("Release has no supported provenance or exact historical tag object.");
  } else {
    if (report.provenance.event === "local") throw new Error("Publication requires hosted producer provenance.");
    if (report.provenance.repository !== env.GITHUB_REPOSITORY) throw new Error("Release provenance repository mismatch.");
    const source = report.provenance;
    const options = { cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 };
    const repository = JSON.parse(execute("gh", ["api", `repos/${source.repository}`], options));
    const run = JSON.parse(execute("gh", ["api", `repos/${source.repository}/actions/runs/${source.run_id}/attempts/${source.run_attempt}`], options));
    verifyReleaseSourceRun(source, run, repository.default_branch);
    const pages = readProducerBindingInventory(execute, options, source, repository.default_branch, pause);
    const artifact = selectProducerBindingArtifact(pages, source, repository.default_branch);
    const directory = mkdtempSync(path.join(tmpdir(), "pm-producer-binding-"));
    const releaseCleanup = registerTempCleanup(directory);
    try {
      verifyProducerBindingFile(downloadProducerBinding(execute, options, source, artifact, directory, pause), report);
      // A download is addressed by name, so after it the inventory must still hold exactly the artifact
      // validated above: a binding replaced while the download was retried is refused.
      if (selectProducerBindingArtifact(readInventoryPages(execute, options, source), source, repository.default_branch).id !== artifact.id) {
        throw new Error("Release producer binding changed while it was downloaded.");
      }
      report.source_run_verified = true;
      report.producer_binding_verified = true;
    } finally {
      rmSync(directory, { recursive: true, force: true });
      releaseCleanup();
    }
  }
  writeFileSync(env.RELEASE_PROVENANCE_OUTPUT, `${JSON.stringify(report)}\n`);
  return report;
}
