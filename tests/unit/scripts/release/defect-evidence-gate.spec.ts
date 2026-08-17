import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseDefectRecurrencePolicy } from "../../../../src/sdk/governance/defect-recurrence.js";
import { main } from "../../../../scripts/release/defect-evidence-gate.mjs";
import { withTempDir } from "../../../helpers/temp.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

const repositoryRoot = process.cwd();
const policy = parseDefectRecurrencePolicy(
  JSON.parse(
    await readFile(
      path.join(repositoryRoot, "config/defect-recurrence-policy.json"),
      "utf8",
    ),
  ),
);
const completeContext = {
  items: [
    ...new Set(policy.families.flatMap((family) => family.historical_item_ids)),
  ].map((id) => ({ id, status: "open", type: "Task" })),
  terminal_statuses: ["closed", "canceled"],
};

describe("defect evidence repository gate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts the complete captured-boundary, evidence, and recurrence corpus", async () => {
    const stdout: string[] = [];
    await expect(
      main(["--json"], {
        repositoryRoot,
        context: completeContext,
        writeStdout: (value: string) => stdout.push(value),
      }),
    ).resolves.toBe(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      ok: true,
      boundary: { ok: true, boundary_count: 9, captured_count: 5 },
      defect_evidence: { ok: true },
      recurrence_policy: { ok: true, family_count: 6 },
    });
  });

  it("loads the authoritative tracker context when a host does not inject one", async () => {
    await withTempPmPath(async () => {
      const stdout: string[] = [];
      await expect(
        main(["--evidence-only", "--json"], {
          repositoryRoot,
          writeStdout: (value: string) => stdout.push(value),
        }),
      ).resolves.toBe(0);
      expect(JSON.parse(stdout.join(""))).toMatchObject({
        checks: [{ name: "defect_evidence", ok: true }],
      });
    });
  });

  it("proves captured boundary and new defect evidence fail closed", async () => {
    const boundaryOutput: string[] = [];
    await expect(
      main(["--boundary-only", "--negative-control", "--json"], {
        repositoryRoot,
        writeStdout: (value: string) => boundaryOutput.push(value),
      }),
    ).resolves.toBe(1);
    expect(JSON.parse(boundaryOutput.join(""))).toMatchObject({
      ok: false,
      boundary: { findings: [{ kind: "invalid_fixture" }] },
      checks: [{ name: "boundary", ok: false }],
    });

    const evidenceOutput: string[] = [];
    await expect(
      main(["--evidence-only", "--negative-control", "--json"], {
        repositoryRoot,
        context: completeContext,
        writeStdout: (value: string) => evidenceOutput.push(value),
      }),
    ).resolves.toBe(1);
    expect(JSON.parse(evidenceOutput.join(""))).toMatchObject({
      defect_evidence: {
        findings: [
          { kind: "missing_escape_class" },
          { kind: "missing_gate_evidence" },
        ],
      },
    });
  });

  it("rejects fixture paths that escape the repository root", async () => {
    await withTempDir("pm-boundary-traversal-", async (tempRoot) => {
      await mkdir(path.join(tempRoot, "config"));
      await Promise.all([
        writeFile(
          path.join(tempRoot, "config/boundary-fixtures.json"),
          JSON.stringify({
            version: 1,
            inventory_scope: "Traversal negative control",
            boundaries: [
              {
                id: "escape",
                producer: "external",
                consumer: "gate",
                format: "JSON",
                fixture_path: "../outside.json",
              },
            ],
          }),
        ),
        writeFile(
          path.join(tempRoot, "config/defect-recurrence-policy.json"),
          JSON.stringify(policy),
        ),
      ]);
      await expect(
        main(["--boundary-only"], { repositoryRoot: tempRoot }),
      ).rejects.toThrow("must stay inside the repository root");
    });
  });

  it("rejects in-tree fixture symlinks that resolve outside the repository root", async () => {
    await withTempDir("pm-boundary-symlink-repo-", async (tempRoot) => {
      await withTempDir("pm-boundary-symlink-outside-", async (outsideRoot) => {
        await mkdir(path.join(tempRoot, "config"));
        const outsideFixture = path.join(outsideRoot, "fixture.json");
        await Promise.all([
          writeFile(outsideFixture, JSON.stringify({ captured: true })),
          writeFile(
            path.join(tempRoot, "config/boundary-fixtures.json"),
            JSON.stringify({
              version: 1,
              inventory_scope: "Symlink escape negative control",
              boundaries: [
                {
                  id: "escape",
                  producer: "external",
                  consumer: "gate",
                  format: "JSON",
                  fixture_path: "config/fixture.json",
                },
              ],
            }),
          ),
          writeFile(
            path.join(tempRoot, "config/defect-recurrence-policy.json"),
            JSON.stringify(policy),
          ),
        ]);
        await symlink(outsideFixture, path.join(tempRoot, "config/fixture.json"));
        await expect(
          main(["--boundary-only"], { repositoryRoot: tempRoot }),
        ).rejects.toThrow("must stay inside the repository root");
      });
    });
  });

  it("fails policy-only execution for missing lineage and malformed controls", async () => {
    const missingOutput: string[] = [];
    await expect(
      main(["--policy-only", "--json"], {
        repositoryRoot,
        context: { items: [], terminal_statuses: ["closed"] },
        writeStdout: (value: string) => missingOutput.push(value),
      }),
    ).resolves.toBe(1);
    expect(
      JSON.parse(missingOutput.join("")).recurrence_policy.findings,
    ).toContainEqual(
      expect.objectContaining({ kind: "missing_historical_item" }),
    );

    const ineffectivePolicy = {
      ...policy,
      families: policy.families.map((family, index) =>
        index === 0 ? { ...family, negative_control: {} } : family,
      ),
    };
    await expect(
      main(["--policy-only", "--json"], {
        repositoryRoot,
        context: completeContext,
        recurrencePolicy: ineffectivePolicy,
      }),
    ).rejects.toThrow("negative_control must select its own family");
  });

  it("renders human output, supports each focused scope, and rejects conflicts", async () => {
    for (const flag of [
      "--boundary-only",
      "--evidence-only",
      "--policy-only",
    ]) {
      const stdout: string[] = [];
      await expect(
        main([flag], {
          repositoryRoot,
          context: completeContext,
          writeStdout: (value: string) => stdout.push(value),
        }),
      ).resolves.toBe(0);
      expect(stdout.join("")).toContain("Defect evidence gate: PASS");
      if (flag === "--boundary-only") {
        expect(stdout.join("")).toContain("Recurrence families: not evaluated");
        expect(stdout.join("")).toContain("Findings: 0");
      }
    }

    const stderr: string[] = [];
    await expect(
      main(["--boundary-only", "--policy-only"], {
        repositoryRoot,
        writeStderr: (value: string) => stderr.push(value),
      }),
    ).resolves.toBe(2);
    expect(stderr.join("")).toContain("Select at most one");

    const processOutput = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await expect(main(["--boundary-only"])).resolves.toBe(0);
    expect(processOutput).toHaveBeenCalledWith(expect.stringContaining("PASS"));
    const processError = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    await expect(main(["--boundary-only", "--evidence-only"])).resolves.toBe(2);
    expect(processError).toHaveBeenCalledWith(
      expect.stringContaining("Select at most one"),
    );
    const fallbackOutput: string[] = [];
    await expect(
      main(["--evidence-only", "--negative-control", "--json"], {
        repositoryRoot,
        context: { items: [] },
        writeStdout: (value: string) => fallbackOutput.push(value),
      }),
    ).resolves.toBe(1);
    expect(
      JSON.parse(fallbackOutput.join("")).defect_evidence.governed_item_count,
    ).toBe(1);

    const humanFailure: string[] = [];
    await expect(
      main(["--boundary-only", "--negative-control"], {
        repositoryRoot,
        writeStdout: (value: string) => humanFailure.push(value),
      }),
    ).resolves.toBe(1);
    expect(humanFailure.join("")).toContain("FAIL");
  });
});
