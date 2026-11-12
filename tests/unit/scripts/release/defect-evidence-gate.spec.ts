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
      recurrence_policy: { ok: true, family_count: policy.families.length },
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

  it("rejects an unregistered recurrence pair even when registered families pass", async () => {
    const stdout: string[] = [];
    await expect(main(["--policy-only", "--negative-control", "--json"], {
      repositoryRoot, context: completeContext, writeStdout: (value: string) => stdout.push(value),
    })).resolves.toBe(1);
    const report = JSON.parse(stdout.join(""));
    expect(report.recurrence_policy.coverage).toMatchObject({
      ok: false, population: { uncovered_item_count: 2, item_count: 2 },
    });
    expect(report.recurrence_policy.findings).toHaveLength(2);
    expect(report.recurrence_policy.findings[0].kind).toBe("unregistered_recurrence_item");
  });

  it("fails while a boundary or defect waiver is inside its notice window and passes once every waiver is outside it", async () => {
    const now = new Date("2026-11-12T06:00:00.000Z");
    const boundaryExpiry = "2026-11-16T00:00:00.000Z";
    const itemExpiry = "2026-11-21T00:00:00.000Z";
    await withTempDir("pm-waiver-notice-", async (tempRoot) => {
      await mkdir(path.join(tempRoot, "config"));
      await Promise.all([
        writeFile(
          path.join(tempRoot, "config/boundary-fixtures.json"),
          JSON.stringify({
            version: 1,
            inventory_scope: "Waiver notice control",
            waiver_notice_days: 14,
            boundaries: [
              {
                id: "soon",
                producer: "external",
                consumer: "gate",
                format: "JSON",
                waiver_reason: "Capture pending.",
                waiver_owner: "pm-owner",
                waiver_expires_at: boundaryExpiry,
              },
            ],
          }),
        ),
        writeFile(
          path.join(tempRoot, "config/defect-recurrence-policy.json"),
          JSON.stringify({ ...policy, waiver_notice_days: 14 }),
        ),
      ]);
      const context = {
        items: [
          ...completeContext.items,
          {
            id: "pm-waived",
            status: "closed",
            type: "Issue",
            completed_at: "2026-10-01T00:00:00.000Z",
            escape_class: "scanner_finding",
            gate_evidence: {
              disposition: "explicit_waiver",
              owner: "pm-waived",
              waiver_reason: "Static false positive.",
              waiver_expires_at: itemExpiry,
            },
          },
        ],
        terminal_statuses: ["closed", "canceled"],
      };
      const failing: string[] = [];
      await expect(
        main(["--waiver-notice", "--json"], {
          repositoryRoot: tempRoot,
          context,
          now,
          writeStdout: (value: string) => failing.push(value),
        }),
      ).resolves.toBe(1);
      expect(JSON.parse(failing.join(""))).toMatchObject({
        ok: false,
        mode: "waiver_notice",
        checks: [
          { name: "boundary", ok: false, findings: [] },
          { name: "defect_evidence", ok: false, findings: [] },
        ],
        waiver_notices: [
          { subject_id: "soon", owner: "pm-owner", expires_at: boundaryExpiry, days_remaining: 3 },
          { subject_id: "pm-waived", owner: "pm-waived", expires_at: itemExpiry, days_remaining: 8 },
        ],
        recurrence_policy: { evaluated: false },
      });

      const human: string[] = [];
      await expect(
        main(["--waiver-notice"], {
          repositoryRoot: tempRoot,
          context,
          now,
          writeStdout: (value: string) => human.push(value),
        }),
      ).resolves.toBe(1);
      expect(human.join("").split("\n").slice(0, 3)).toEqual([
        "Waiver notice gate: FAIL",
        `Waiver notice: soon expires ${boundaryExpiry} (3 whole days left; owner pm-owner)`,
        `Waiver notice: pm-waived expires ${itemExpiry} (8 whole days left; owner pm-waived)`,
      ]);

      const evidenceGate: string[] = [];
      await expect(
        main(["--json"], {
          repositoryRoot: tempRoot,
          context,
          now,
          writeStdout: (value: string) => evidenceGate.push(value),
        }),
      ).resolves.toBe(0);
      expect(JSON.parse(evidenceGate.join("")).waiver_notices).toHaveLength(2);

      await expect(
        main(["--waiver-notice"], {
          repositoryRoot: tempRoot,
          context,
          now: new Date("2026-10-01T00:00:00.000Z"),
          writeStdout: () => undefined,
        }),
      ).resolves.toBe(0);

      const expired: string[] = [];
      await expect(
        main(["--waiver-notice", "--json"], {
          repositoryRoot: tempRoot,
          context,
          now: new Date("2026-11-17T00:00:00.000Z"),
          writeStdout: (value: string) => expired.push(value),
        }),
      ).resolves.toBe(1);
      expect(JSON.parse(expired.join(""))).toMatchObject({
        checks: [
          { name: "boundary", findings: [{ boundary_id: "soon", kind: "expired_waiver" }] },
          { name: "defect_evidence", findings: [] },
        ],
        waiver_notices: [{ subject_id: "pm-waived", days_remaining: 4 }],
      });
    });
  });

  it("fails notice mode closed when any boundary or defect-evidence record cannot be evaluated", async () => {
    await withTempDir("pm-waiver-notice-invalid-", async (tempRoot) => {
      await mkdir(path.join(tempRoot, "config"));
      const writeRegistry = (registry: object) =>
        writeFile(path.join(tempRoot, "config/boundary-fixtures.json"), JSON.stringify(registry));
      await writeFile(
        path.join(tempRoot, "config/defect-recurrence-policy.json"),
        JSON.stringify(policy),
      );
      const expired = {
        id: "expired",
        producer: "external",
        consumer: "gate",
        format: "JSON",
        waiver_reason: "Capture pending.",
        waiver_owner: "pm-owner",
        waiver_expires_at: "2026-01-01T00:00:00.000Z",
      };
      const { producer: _producer, ...producerless } = expired;
      for (const [registry, kind] of [
        [{ version: 1, inventory_scope: "Bad window", waiver_notice_days: "14", boundaries: [expired] }, "invalid_registry"],
        [{ version: 1, inventory_scope: "Bad waiver", boundaries: [{ ...expired, waiver_expires_at: "soon" }] }, "invalid_waiver"],
        [{ version: 1, inventory_scope: "Bad boundary", boundaries: [producerless] }, "invalid_boundary"],
        [{ version: 1, inventory_scope: "Duplicate", boundaries: [{ ...expired, waiver_expires_at: "2099-01-01T00:00:00.000Z" }, expired] }, "duplicate_boundary"],
      ] as const) {
        await writeRegistry(registry);
        const stdout: string[] = [];
        await expect(
          main(["--waiver-notice", "--json"], {
            repositoryRoot: tempRoot,
            context: completeContext,
            writeStdout: (value: string) => stdout.push(value),
          }),
        ).resolves.toBe(1);
        expect(JSON.parse(stdout.join("")).checks[0]).toMatchObject({
          name: "boundary",
          ok: false,
          findings: [{ kind }],
        });
      }

      await writeRegistry({ version: 1, inventory_scope: "Clean", boundaries: [] });
      const malformedWaiver: string[] = [];
      await expect(
        main(["--waiver-notice", "--json"], {
          repositoryRoot: tempRoot,
          context: {
            ...completeContext,
            items: [
              ...completeContext.items,
              {
                id: "pm-malformed-waiver",
                status: "closed",
                type: "Issue",
                completed_at: "2026-10-01T00:00:00.000Z",
                escape_class: "scanner_finding",
                gate_evidence: { disposition: "explicit_waiver", owner: "", waiver_reason: "x", waiver_expires_at: "soon" },
              },
            ],
          },
          writeStdout: (value: string) => malformedWaiver.push(value),
        }),
      ).resolves.toBe(1);
      expect(JSON.parse(malformedWaiver.join("")).checks[1]).toMatchObject({
        name: "defect_evidence",
        ok: false,
        findings: [{ item_id: "pm-malformed-waiver", kind: "invalid_gate_evidence" }],
      });
    });
  });

  it("seeds a waiver inside the notice window under the notice negative control", async () => {
    const stdout: string[] = [];
    await expect(
      main(["--waiver-notice", "--negative-control", "--json"], {
        repositoryRoot,
        context: completeContext,
        now: new Date("2026-11-12T06:00:00.000Z"),
        writeStdout: (value: string) => stdout.push(value),
      }),
    ).resolves.toBe(1);
    const report = JSON.parse(stdout.join(""));
    expect(report.boundary.findings).toEqual([]);
    expect(report.waiver_notices.map((notice: { subject_id: string }) => notice.subject_id)).toEqual([
      "negative-control-waiver",
      "pm-negative-control",
    ]);

    // Registries that declare no window still get a seeded one-day window.
    await withTempDir("pm-waiver-notice-undeclared-", async (tempRoot) => {
      await mkdir(path.join(tempRoot, "config"));
      const { waiver_notice_days: _omitted, ...undeclaredPolicy } = policy;
      await Promise.all([
        writeFile(
          path.join(tempRoot, "config/boundary-fixtures.json"),
          JSON.stringify({ version: 1, inventory_scope: "No window declared", boundaries: [] }),
        ),
        writeFile(
          path.join(tempRoot, "config/defect-recurrence-policy.json"),
          JSON.stringify(undeclaredPolicy),
        ),
      ]);
      const undeclared: string[] = [];
      await expect(
        main(["--waiver-notice", "--negative-control", "--json"], {
          repositoryRoot: tempRoot,
          context: completeContext,
          writeStdout: (value: string) => undeclared.push(value),
        }),
      ).resolves.toBe(1);
      expect(JSON.parse(undeclared.join("")).waiver_notices).toHaveLength(2);
    });

    const conflict: string[] = [];
    await expect(
      main(["--waiver-notice", "--boundary-only"], {
        repositoryRoot,
        writeStderr: (value: string) => conflict.push(value),
      }),
    ).resolves.toBe(2);
    expect(conflict.join("")).toContain("--waiver-notice");
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
    expect(humanFailure.join("").split("\n").slice(0, 2)).toEqual([
      "Defect evidence gate: FAIL",
      expect.stringMatching(
        /^Finding \[boundary\] tests\/fixtures\/boundaries\/.+ lacks captured provenance/u,
      ),
    ]);
  });
});
