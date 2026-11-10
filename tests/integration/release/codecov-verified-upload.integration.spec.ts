import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { withTempDir } from "../../helpers/temp.js";

const assetDigest = "ca1d64196d2d34771084afe76ea657d581bf628e31d993ff8e52ea09cc88a56d";
const assetUrl = "https://api.github.com/repos/codecov/codecov-cli/releases/assets/470877726";

/** Relevant workflow fields for the required uploader bootstrap and consumers. */
interface UploadStep {
  id?: string;
  name?: string;
  run?: string;
  shell?: string;
  if?: string;
  "continue-on-error"?: boolean;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}

describe("verified Codecov upload bootstrap (pm-2x67z9)", () => {
  it("requires checksum verification and quiet logs for both mandatory exact-head uploads", async () => {
    const workflow = parse(await readFile(".github/workflows/ci.yml", "utf8")) as { jobs: { coverage: { steps: UploadStep[] } } };
    const steps = workflow.jobs.coverage.steps;
    const bootstrapIndex = steps.findIndex((step) => step.name === "Verify pinned Codecov CLI");
    expect(bootstrapIndex).toBeGreaterThanOrEqual(0);
    const bootstrap = steps[bootstrapIndex];
    expect(bootstrap).toMatchObject({ id: "codecov_cli", shell: "bash", if: "${{ !cancelled() && steps.shard_admission.outcome == 'success' }}" });
    expect(bootstrap["continue-on-error"]).toBeUndefined();
    expect(bootstrap.run).toContain(assetUrl);
    expect(bootstrap.run).toContain("Accept: application/octet-stream");
    expect(bootstrap.run).toContain(assetDigest);
    expect(bootstrap.env).toEqual({ GH_TOKEN: "${{ github.token }}" });
    expect(bootstrap.run).toContain('Authorization: Bearer ${GH_TOKEN}');
    expect(bootstrap.run).toContain("--fail --show-error --silent --location --proto '=https' --tlsv1.2");
    expect(bootstrap.run).toContain('node --input-type=module - "${codecov_binary}"');
    expect(bootstrap.run).not.toMatch(/--insecure|curl\s+-k\b/);
    const uploads = steps.filter((step) => step.name === "Upload coverage to Codecov" || step.name === "Upload test results to Codecov");
    expect(uploads).toHaveLength(2);
    for (const upload of uploads) {
      expect(steps.indexOf(upload)).toBeGreaterThan(bootstrapIndex);
      expect(upload.if).toBe("${{ !cancelled() && steps.codecov_cli.outcome == 'success' }}");
      expect(upload["continue-on-error"]).toBeUndefined();
      expect(upload.with).toMatchObject({ binary: "${{ runner.temp }}/pm-codecov/codecov", url: "https://codecov.io", fail_ci_if_error: true, verbose: false,
        override_commit: "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}" });
      expect(upload.with).not.toHaveProperty("skip_validation");
    }
  });

  it.each([true, false])("executes the actual verifier before chmod (approved bytes: %s)", async (approved) => {
    const workflow = parse(await readFile(".github/workflows/ci.yml", "utf8")) as { jobs: { coverage: { steps: UploadStep[] } } };
    const script = workflow.jobs.coverage.steps.find((step) => step.name === "Verify pinned Codecov CLI")?.run;
    expect(script).toBeTypeOf("string");
    const approvedPayload = "independent approved uploader fixture\n";
    const fixtureDigest = createHash("sha256").update(approvedPayload).digest("hex");
    await withTempDir("pm-codecov-verification-", async (root) => {
      // Isolate only download bytes; the workflow's checksum, shell failure and real chmod execute unchanged.
      const boundary = `curl() {
        printf '%s\\n' "$@" > "\${RUNNER_TEMP}/curl-args"
        while [ "$#" -gt 0 ]; do
          if [ "$1" = "--output" ]; then printf '%s' "$PM_CODECOV_PAYLOAD" > "$2"; return; fi
          shift
        done
        return 2
      }
      chmod() { command chmod "$@"; printf verified > "\${RUNNER_TEMP}/chmod-ran"; }
      `;
      const result = spawnSync("bash", ["-euo", "pipefail", "-s"], {
        cwd: root, input: boundary + script!.replace(assetDigest, fixtureDigest), encoding: "utf8", timeout: 10_000,
        env: { ...process.env, GH_TOKEN: "fixture-only-token", RUNNER_TEMP: root.replaceAll("\\", "/"), PM_CODECOV_PAYLOAD: approved ? approvedPayload : "corrupt uploader bytes\n" },
      });
      expect(result.error).toBeUndefined();
      const argv = (await readFile(path.join(root, "curl-args"), "utf8")).trim().split("\n");
      const headers = argv.flatMap((argument, index) => argument === "--header" ? [argv[index + 1]] : []);
      expect(argv).toContain(assetUrl);
      expect(headers).toEqual(expect.arrayContaining(["Accept: application/octet-stream", "Authorization: Bearer fixture-only-token"]));
      if (approved) expect(result.status, result.stderr).toBe(0);
      else expect(result.status).not.toBe(0);
      expect((await readdir(root)).includes("chmod-ran")).toBe(approved);
      expect(await readFile(path.join(root, "pm-codecov", "codecov"), "utf8")).toBe(approved ? approvedPayload : "corrupt uploader bytes\n");
    });
  });
});
