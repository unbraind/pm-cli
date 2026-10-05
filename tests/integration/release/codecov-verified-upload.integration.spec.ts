import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { withTempDir } from "../../helpers/temp.js";

const assetDigest = "ca1d64196d2d34771084afe76ea657d581bf628e31d993ff8e52ea09cc88a56d";
const assetUrl = "https://github.com/codecov/codecov-cli/releases/download/v11.3.1/codecovcli_linux";

/** Relevant workflow fields for the required uploader bootstrap and consumers. */
interface UploadStep {
  id?: string;
  name?: string;
  run?: string;
  shell?: string;
  if?: string;
  "continue-on-error"?: boolean;
  with?: Record<string, unknown>;
}

describe("verified Codecov upload bootstrap (pm-2x67z9)", () => {
  it("requires checksum verification before either mandatory exact-head upload", async () => {
    const workflow = parse(await readFile(".github/workflows/ci.yml", "utf8")) as { jobs: { coverage: { steps: UploadStep[] } } };
    const steps = workflow.jobs.coverage.steps;
    const bootstrapIndex = steps.findIndex((step) => step.name === "Verify pinned Codecov CLI");
    expect(bootstrapIndex).toBeGreaterThanOrEqual(0);
    const bootstrap = steps[bootstrapIndex];
    expect(bootstrap).toMatchObject({ id: "codecov_cli", shell: "bash", if: "${{ !cancelled() }}" });
    expect(bootstrap["continue-on-error"]).toBeUndefined();
    expect(bootstrap.run).toContain(assetUrl);
    expect(bootstrap.run).toContain(assetDigest);
    expect(bootstrap.run).toContain("--fail --show-error --silent --location --proto '=https' --tlsv1.2");
    expect(bootstrap.run).toContain("sha256sum --check --strict");
    expect(bootstrap.run).not.toMatch(/--insecure|curl\s+-k\b/);
    const uploads = steps.filter((step) => step.name === "Upload coverage to Codecov" || step.name === "Upload test results to Codecov");
    expect(uploads).toHaveLength(2);
    for (const upload of uploads) {
      expect(steps.indexOf(upload)).toBeGreaterThan(bootstrapIndex);
      expect(upload.if).toBe("${{ !cancelled() && steps.codecov_cli.outcome == 'success' }}");
      expect(upload["continue-on-error"]).toBeUndefined();
      expect(upload.with).toMatchObject({ binary: "${{ runner.temp }}/pm-codecov/codecov", url: "https://codecov.io", fail_ci_if_error: true,
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
        env: { ...process.env, RUNNER_TEMP: root.replaceAll("\\", "/"), PM_CODECOV_PAYLOAD: approved ? approvedPayload : "corrupt uploader bytes\n" },
      });
      expect(result.error).toBeUndefined();
      if (approved) expect(result.status, result.stderr).toBe(0);
      else expect(result.status).not.toBe(0);
      expect((await readdir(root)).includes("chmod-ran")).toBe(approved);
      expect(await readFile(path.join(root, "pm-codecov", "codecov"), "utf8")).toBe(approved ? approvedPayload : "corrupt uploader bytes\n");
    });
  });
});
