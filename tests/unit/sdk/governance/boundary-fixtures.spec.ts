import { describe, expect, it } from "vitest";

import {
  evaluateBoundaryFixtures,
  type BoundaryFixtureRegistry,
  type BoundaryFixtureSample,
} from "../../../../src/sdk/governance/boundary-fixtures.js";

const sample: BoundaryFixtureSample = {
  version: 1,
  boundary_id: "claude-project-slug",
  capture_source: "captured_redacted",
  capture_provenance:
    "Observed from a Claude Code project directory and redacted before commit.",
  redactions: ["workspace prefix replaced with /workspace"],
  input: { workspace: "/workspace/project with+symbols" },
  observed: { project_directory: "-workspace-project-with-symbols" },
};

const registry: BoundaryFixtureRegistry = {
  version: 1,
  inventory_scope:
    "External values consumed by author, package-manager, and release adapters.",
  boundaries: [
    {
      id: "claude-project-slug",
      producer: "Claude Code",
      consumer: "src/core/shared/author.ts",
      format: "filesystem directory slug",
      fixture_path: "tests/fixtures/boundaries/claude-project-slug.json",
    },
    {
      id: "provider-response",
      producer: "hosted provider",
      consumer: "repository assurance",
      format: "provider JSON response",
      waiver_reason: "Provider test tenant cannot be committed.",
      waiver_owner: "pm-provider",
      waiver_expires_at: "2026-08-18T00:00:00.000Z",
    },
  ],
};

describe("boundary fixture SDK", () => {
  it("accepts captured samples and live explicit waivers", () => {
    expect(
      evaluateBoundaryFixtures(
        registry,
        { "tests/fixtures/boundaries/claude-project-slug.json": sample },
        new Date("2026-08-16T00:00:00.000Z"),
      ),
    ).toEqual({
      ok: true,
      boundary_count: 2,
      captured_count: 1,
      waived_count: 1,
      findings: [],
    });
  });

  it("fails closed for invalid registries, duplicate entries, and absent fixtures", () => {
    expect(
      evaluateBoundaryFixtures({ ...registry, version: 2 as 1 }, {}).findings,
    ).toEqual([expect.objectContaining({ kind: "invalid_registry" })]);
    const report = evaluateBoundaryFixtures(
      {
        ...registry,
        boundaries: [
          registry.boundaries[0]!,
          registry.boundaries[0]!,
          { id: "", producer: "", consumer: "", format: "", fixture_path: "" },
        ],
      },
      {},
    );
    expect(report.ok).toBe(false);
    expect(report.findings.map((finding) => finding.kind)).toEqual([
      "duplicate_boundary",
      "missing_fixture",
      "invalid_boundary",
    ]);
    expect(
      evaluateBoundaryFixtures(
        { ...registry, boundaries: [null, "boundary"] as never },
        {},
      ),
    ).toMatchObject({
      ok: false,
      boundary_count: 2,
      captured_count: 0,
      waived_count: 0,
      findings: [
        expect.objectContaining({ kind: "invalid_boundary" }),
        expect.objectContaining({ kind: "invalid_boundary" }),
      ],
    });
    expect(
      evaluateBoundaryFixtures(
        {
          ...registry,
          boundaries: [
            {
              id: 7,
              producer: "producer",
              consumer: "consumer",
              format: "JSON",
              fixture_path: "fixture.json",
            },
          ] as never,
        },
        {},
      ),
    ).toMatchObject({
      ok: false,
      findings: [
        expect.objectContaining({
          boundary_id: "unknown",
          kind: "invalid_boundary",
        }),
      ],
    });
    expect(
      evaluateBoundaryFixtures(
        {
          ...registry,
          boundaries: [
            {
              id: "invalid-producer",
              producer: "",
              consumer: "consumer",
              format: "JSON",
              fixture_path: "fixture.json",
            },
          ],
        },
        {},
      ).findings,
    ).toEqual([
      expect.objectContaining({
        boundary_id: "invalid-producer",
        kind: "invalid_boundary",
      }),
    ]);
  });

  it("rejects mismatched, self-generated, malformed, or unsafe samples", () => {
    const fixturePath = "tests/fixtures/boundaries/claude-project-slug.json";
    const malformed = evaluateBoundaryFixtures(
      { ...registry, boundaries: [registry.boundaries[0]!] },
      { [fixturePath]: [] },
    );
    expect(malformed.findings).toEqual([
      expect.objectContaining({ kind: "invalid_fixture" }),
    ]);
    const report = evaluateBoundaryFixtures(
      { ...registry, boundaries: [registry.boundaries[0]!] },
      {
        [fixturePath]: {
          ...sample,
          boundary_id: "wrong",
          capture_source: "self_generated",
          capture_provenance: "",
          redactions: [],
          input: {
            token: ["gh", "p_", "ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"].join(""),
          },
          observed: { home: "/home/steve/private" },
        },
      },
    );
    expect(report.findings.map((finding) => finding.kind)).toEqual([
      "fixture_boundary_mismatch",
      "invalid_fixture",
      "unsafe_fixture",
      "unsafe_fixture",
    ]);
  });

  it("rejects malformed and expired waivers", () => {
    const report = evaluateBoundaryFixtures(
      {
        ...registry,
        boundaries: [
          {
            ...registry.boundaries[1]!,
            waiver_reason: "",
            waiver_expires_at: "never",
          },
          {
            id: "expired",
            producer: "provider",
            consumer: "adapter",
            format: "JSON",
            waiver_reason: "Temporary",
            waiver_owner: "pm-owner",
            waiver_expires_at: "2026-08-15T00:00:00.000Z",
          },
        ],
      },
      {},
      new Date("2026-08-16T00:00:00.000Z"),
    );
    expect(report.findings.map((finding) => finding.kind)).toEqual([
      "expired_waiver",
      "invalid_waiver",
    ]);
    expect(report.waived_count).toBe(0);
  });
});
