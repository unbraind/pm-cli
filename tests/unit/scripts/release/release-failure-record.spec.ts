/**
 * @module release-failure-record tests
 *
 * Proves the blocked-release alert can name a cause the run actually produced:
 * a failing gate's verdict is recorded, blocking identifiers and their declared
 * reasons are rendered from structured fields only, and every degenerate input
 * falls back to emitting nothing so the workflow's preflight detection stays in
 * charge. The negative control proves the rendered cause tracks the recorded
 * verdict rather than being fixed text.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_CAPTURE_CHARS,
  MAX_RENDERED_BLOCKERS,
  RECORD_SCHEMA,
  collectBlockingSummaries,
  collectWorkflowFailureSummaries,
  describeFailureRecord,
  main,
  parseGateVerdict,
  readFailureRecord,
  recordGateFailure,
  recordWorkflowFailure,
  renderFailureOutputs,
} from "../../../../scripts/release/release-failure-record.mjs";

const temporaryRoots: string[] = [];

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-failure-record-"));
  temporaryRoots.push(root);
  return root;
}

/** The verdict shape the Sentry reliability gate printed on the reference failure. */
function sentryVerdict(shortIds: string[]): string {
  return JSON.stringify({
    ok: false,
    thresholds: { sentry: { max_high: 0 } },
    sentry: {
      high: shortIds.length,
      blocking_short_ids: shortIds,
      blocking_reasons: shortIds.map((shortId) => ({
        short_id: shortId,
        reason: "unexpected_fault",
      })),
    },
    telemetry: { checked: false, ok: true },
  });
}

afterEach(async () => {
  vi.unstubAllEnvs();
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

describe("recordWorkflowFailure", () => {
  it("records failed jobs and steps from GitHub's structured run response", async () => {
    const root = await fixtureRoot();
    const target = path.join(root, "workflow-record.json");

    const document = recordWorkflowFailure(
      {
        stage: "release-workflow",
        status: 1,
        run: {
          databaseId: 32615543095,
          status: "completed",
          conclusion: "failure",
          jobs: [
            {
              name: "Build, Test, Publish",
              conclusion: "failure",
              steps: [
                { name: "Build", conclusion: "success" },
                { name: "Publish to npm", conclusion: "failure" },
              ],
            },
          ],
        },
      },
      target,
    );

    expect(document).toMatchObject({
      kind: "workflow",
      stage: "release-workflow",
      workflow_run: {
        database_id: 32615543095,
        conclusion: "failure",
        failed_steps: [
          { job: "Build, Test, Publish", step: "Publish to npm" },
        ],
      },
    });
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(document);
  });

  it("retains a failed job when GitHub provides no failed step", () => {
    expect(
      collectWorkflowFailureSummaries({
        jobs: [{ name: "Publish", conclusion: "failure", steps: [] }],
      }),
    ).toEqual([{ job: "Publish", step: "" }]);
  });

  it("ignores success, skipped, malformed, and prose-only fields", () => {
    expect(
      collectWorkflowFailureSummaries({
        jobs: [
          {
            name: "Publish",
            conclusion: "success",
            steps: [{ name: "npm publish failed", conclusion: "success" }],
          },
          { name: "Skipped", conclusion: "skipped", steps: [] },
          null,
        ],
      }),
    ).toEqual([]);
  });

  it("covers sparse and malformed structured workflow fields without reading prose", async () => {
    const root = await fixtureRoot();
    const target = path.join(root, "sparse-workflow.json");
    vi.stubEnv("RELEASE_FAILURE_RECORD", target);

    expect(recordWorkflowFailure({ stage: 42, status: "1", run: null })).toMatchObject({
      stage: "",
      status: null,
      workflow_run: {
        database_id: null,
        status: "",
        conclusion: "",
        head_sha: "",
        head_branch: "",
        event: "",
        failed_steps: [],
      },
    });
    expect(recordWorkflowFailure({ run: "not-an-object" }, target)?.workflow_run).toMatchObject({
      database_id: null,
      failed_steps: [],
    });
    vi.stubEnv("RELEASE_FAILURE_RECORD", " ");
    expect(recordWorkflowFailure({ run: {} })).toBeNull();

    expect(collectWorkflowFailureSummaries({ jobs: "invalid" })).toEqual([]);
    expect(
      collectWorkflowFailureSummaries({
        jobs: [
          7,
          { name: " ", conclusion: "failure" },
          {
            name: "Publish",
            conclusion: "failure",
            steps: [null, 4, { name: "", conclusion: "failure" }, { name: "ok", conclusion: "success" }],
          },
          { name: "Verify", conclusion: "failure", steps: "invalid" },
        ],
      }),
    ).toEqual([
      { job: "Publish", step: "" },
      { job: "Verify", step: "" },
    ]);
  });
});

describe("recordGateFailure", () => {
  it("writes the failing gate, its status and its captured output", async () => {
    const root = await fixtureRoot();
    const target = path.join(root, "nested", "record.json");

    const document = recordGateFailure(
      {
        gate: "sentry-telemetry-gate",
        status: 1,
        stdout: sentryVerdict(["PM-CLI-2X"]),
        stderr: " boom ",
      },
      target,
    );

    expect(document?.stage).toBe("sentry-telemetry-gate");
    expect(document?.status).toBe(1);
    expect(document?.stderr).toBe("boom");
    const written = JSON.parse(await readFile(target, "utf8"));
    expect(written.schema).toBe(RECORD_SCHEMA);
    expect(written.stage).toBe("sentry-telemetry-gate");
  });

  it("falls back to the environment path and bounds oversized capture", async () => {
    const root = await fixtureRoot();
    const target = path.join(root, "record.json");
    vi.stubEnv("RELEASE_FAILURE_RECORD", target);

    const document = recordGateFailure({
      gate: "coverage",
      status: 2,
      stdout: "x".repeat(MAX_CAPTURE_CHARS + 25),
    });

    expect(document?.stdout.endsWith("[truncated]")).toBe(true);
    expect(document?.stdout.length).toBe(MAX_CAPTURE_CHARS + "[truncated]".length);
    expect(document?.stderr).toBe("");
  });

  it("records nothing when no target path is declared", () => {
    vi.stubEnv("RELEASE_FAILURE_RECORD", "  ");
    expect(recordGateFailure({ gate: "coverage", status: 1 })).toBeNull();
  });

  it("stores a null status when the exit code is not an integer", async () => {
    const root = await fixtureRoot();
    const target = path.join(root, "record.json");

    const document = recordGateFailure(
      { gate: "coverage", status: null, stdout: 42 },
      target,
    );

    expect(document?.status).toBeNull();
    expect(document?.stdout).toBe("");
  });
});

describe("parseGateVerdict", () => {
  it("parses a JSON verdict and rejects everything else", () => {
    expect(parseGateVerdict('{"ok":false}')).toEqual({ ok: false });
    expect(parseGateVerdict("")).toBeNull();
    expect(parseGateVerdict("Gate failed: coverage")).toBeNull();
    expect(parseGateVerdict("null")).toBeNull();
    expect(parseGateVerdict("[1,2]")).toEqual([1, 2]);
    expect(parseGateVerdict(undefined)).toBeNull();
  });
});

describe("collectBlockingSummaries", () => {
  it("pairs declared blocking identifiers with their declared reasons", () => {
    const verdict = JSON.parse(sentryVerdict(["PM-CLI-2X", "PM-CLI-19"]));
    expect(collectBlockingSummaries(verdict)).toEqual([
      "PM-CLI-2X (unexpected_fault)",
      "PM-CLI-19 (unexpected_fault)",
    ]);
  });

  it("renders a bare identifier when the verdict declares no reason for it", () => {
    expect(
      collectBlockingSummaries({
        sentry: { blocking_short_ids: ["PM-CLI-7", "", 5] },
      }),
    ).toEqual(["PM-CLI-7"]);
  });

  it("ignores non-object sections, absent id lists and malformed reason rows", () => {
    expect(
      collectBlockingSummaries({
        scalar: 3,
        empty: null,
        telemetry: { checked: true },
        sentry: {
          blocking_short_ids: ["PM-CLI-1"],
          blocking_reasons: [{ short_id: "", reason: "x" }, { short_id: "PM-CLI-1" }, 7],
        },
      }),
    ).toEqual(["PM-CLI-1"]);
  });

  it("yields nothing for an absent verdict", () => {
    expect(collectBlockingSummaries(null)).toEqual([]);
    expect(collectBlockingSummaries({ sentry: { blocking_reasons: 4 } })).toEqual([]);
  });
});

describe("describeFailureRecord", () => {
  it("names the gate and its blocking identifiers", () => {
    const described = describeFailureRecord({
      schema: RECORD_SCHEMA,
      stage: "sentry-telemetry-gate",
      status: 1,
      stdout: sentryVerdict(["PM-CLI-2X"]),
    });

    expect(described).toEqual({
      stage: "sentry-telemetry-gate",
      cause:
        "Gate sentry-telemetry-gate failed with status 1. Blocking: PM-CLI-2X (unexpected_fault).",
    });
  });

  it("caps rendered identifiers and reports the remainder", () => {
    const ids = Array.from(
      { length: MAX_RENDERED_BLOCKERS + 3 },
      (_value, index) => `PM-CLI-${index}`,
    );

    const described = describeFailureRecord({
      schema: RECORD_SCHEMA,
      stage: "sentry-telemetry-gate",
      status: 1,
      stdout: sentryVerdict(ids),
    });

    expect(described?.cause).toContain("and 3 more.");
    expect(described?.cause).not.toContain(`PM-CLI-${MAX_RENDERED_BLOCKERS}`);
  });

  it("names the gate alone when the verdict declares no blockers", () => {
    expect(
      describeFailureRecord({
        schema: RECORD_SCHEMA,
        stage: "coverage",
        status: 2,
        stdout: "Coverage for lines dropped below the threshold",
      }),
    ).toEqual({ stage: "coverage", cause: "Gate coverage failed with status 2." });
  });

  it("reports an unreported status when the document carries none", () => {
    expect(
      describeFailureRecord({ schema: RECORD_SCHEMA, stage: "coverage", status: null })
        ?.cause,
    ).toBe("Gate coverage failed with an unreported status.");
  });

  it("refuses documents with a foreign schema or no stage", () => {
    expect(describeFailureRecord(null)).toBeNull();
    expect(describeFailureRecord({ schema: "other/1", stage: "coverage" })).toBeNull();
    expect(describeFailureRecord({ schema: RECORD_SCHEMA, stage: "   " })).toBeNull();
  });

  it("renders downstream workflow failures from job and step fields", () => {
    expect(
      describeFailureRecord({
        schema: RECORD_SCHEMA,
        kind: "workflow",
        stage: "release-workflow",
        status: 1,
        workflow_run: {
          database_id: 32615543095,
          conclusion: "failure",
          failed_steps: [
            { job: "Build, Test, Publish", step: "Publish to npm" },
          ],
        },
      }),
    ).toEqual({
      stage: "release-workflow",
      cause:
        "Workflow release-workflow run 32615543095 failed with status 1. " +
        "Failed: Build, Test, Publish / Publish to npm.",
    });
  });

  it("renders sparse workflow failures and ignores malformed failed-step rows", () => {
    expect(
      describeFailureRecord({
        schema: RECORD_SCHEMA,
        kind: "workflow",
        stage: "npm-verification",
        workflow_run: {
          database_id: "not-an-integer",
          failed_steps: [null, 7, { job: "" }, { job: "Publish", step: "" }],
        },
      })?.cause,
    ).toBe(
      "Workflow npm-verification failed with an unreported status. Failed: Publish.",
    );
    expect(
      describeFailureRecord({
        schema: RECORD_SCHEMA,
        kind: "workflow",
        stage: "release-discovery",
        status: 1,
        workflow_run: null,
      })?.cause,
    ).toBe("Workflow release-discovery failed with status 1.");
  });
});

describe("readFailureRecord", () => {
  it("reads a written document and rejects absent, blank or malformed ones", async () => {
    const root = await fixtureRoot();
    const target = path.join(root, "record.json");
    recordGateFailure({ gate: "coverage", status: 1 }, target);

    expect(readFailureRecord(target)).toMatchObject({ stage: "coverage" });
    expect(readFailureRecord("")).toBeNull();
    expect(readFailureRecord(path.join(root, "missing.json"))).toBeNull();

    const broken = path.join(root, "broken.json");
    await writeFile(broken, "{not json", "utf8");
    expect(readFailureRecord(broken)).toBeNull();

    const scalar = path.join(root, "scalar.json");
    await writeFile(scalar, "12", "utf8");
    expect(readFailureRecord(scalar)).toBeNull();
  });
});

describe("renderFailureOutputs and main", () => {
  it("emits step outputs the workflow can consume", async () => {
    const root = await fixtureRoot();
    const target = path.join(root, "record.json");
    recordGateFailure(
      {
        gate: "sentry-telemetry-gate",
        status: 1,
        stdout: sentryVerdict(["PM-CLI-2X"]),
      },
      target,
    );

    const rendered = renderFailureOutputs(target);

    expect(rendered).toBe(
      "failure_stage=sentry-telemetry-gate\n" +
        "failure_cause=Gate sentry-telemetry-gate failed with status 1. " +
        "Blocking: PM-CLI-2X (unexpected_fault).\n",
    );
    expect(rendered.includes("\nfailure_cause=")).toBe(true);
  });

  it("emits nothing when no usable document exists, leaving the preflight fallback in charge", () => {
    expect(renderFailureOutputs("")).toBe("");
  });

  it("writes the rendered outputs to stdout through the entrypoint", async () => {
    const root = await fixtureRoot();
    const target = path.join(root, "record.json");
    recordGateFailure({ gate: "coverage", status: 2 }, target);
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    const rendered = main([target]);

    expect(rendered).toBe(
      "failure_stage=coverage\nfailure_cause=Gate coverage failed with status 2.\n",
    );
    expect(write).toHaveBeenCalledWith(rendered);
    write.mockRestore();
  });

  it("emits nothing when the entrypoint is given no argument", () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(main([])).toBe("");
    write.mockRestore();
  });

  it("records workflow and stage failures through both structured CLI modes", async () => {
    const root = await fixtureRoot();
    const stageTarget = path.join(root, "stage.json");
    const workflowTarget = path.join(root, "workflow.json");
    const malformedTarget = path.join(root, "malformed.json");

    expect(main(["record-stage", stageTarget, "release-discovery", "7"])).toBe("");
    expect(readFailureRecord(stageTarget)).toMatchObject({
      stage: "release-discovery",
      status: 7,
    });
    expect(main(["record-stage"])).toBe("");
    expect(
      main(
        ["record-workflow", workflowTarget, "release-workflow", "not-an-integer"],
        () => JSON.stringify({
          databaseId: 17,
          jobs: [{ name: "Publish", conclusion: "failure", steps: [] }],
        }),
      ),
    ).toBe("");
    expect(readFailureRecord(workflowTarget)).toMatchObject({
      stage: "release-workflow",
      status: null,
      workflow_run: {
        database_id: 17,
        failed_steps: [{ job: "Publish", step: "" }],
      },
    });
    expect(
      main(["record-workflow", malformedTarget], () => "{not-json"),
    ).toBe("");
    expect(readFailureRecord(malformedTarget)).toMatchObject({
      stage: "",
      workflow_run: { failed_steps: [] },
    });
    const scalarTarget = path.join(root, "scalar-input.json");
    expect(main(["record-workflow", scalarTarget], () => "null")).toBe("");
    expect(readFailureRecord(scalarTarget)).toMatchObject({
      workflow_run: { failed_steps: [] },
    });
    expect(main(["record-workflow"], () => "{}")).toBe("");
  });

  it("negative control: the rendered cause tracks the recorded verdict", async () => {
    const root = await fixtureRoot();
    const first = path.join(root, "first.json");
    const second = path.join(root, "second.json");
    recordGateFailure(
      { gate: "sentry-telemetry-gate", status: 1, stdout: sentryVerdict(["PM-CLI-2X"]) },
      first,
    );
    recordGateFailure(
      { gate: "hosted-analysis", status: 3, stdout: sentryVerdict(["PM-CLI-99"]) },
      second,
    );

    expect(renderFailureOutputs(first)).not.toBe(renderFailureOutputs(second));
    expect(renderFailureOutputs(second)).toContain("PM-CLI-99");
    expect(renderFailureOutputs(second)).toContain("failure_stage=hosted-analysis");
  });
});
