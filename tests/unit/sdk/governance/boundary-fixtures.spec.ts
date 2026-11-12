import { describe, expect, it } from "vitest";

import {
  evaluateBoundaryFixtures,
  isWaiverNoticeDays,
  MAX_WAIVER_NOTICE_DAYS,
  sortWaiverNotices,
  waiverNoticeFor,
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
      waiver_notices: [],
      findings: [],
    });
  });

  it("reports live waivers inside the declared notice window without failing", () => {
    const fixtures = {
      "tests/fixtures/boundaries/claude-project-slug.json": sample,
    };
    const now = new Date("2026-08-16T00:00:00.000Z");
    expect(
      evaluateBoundaryFixtures({ ...registry, waiver_notice_days: 3 }, fixtures, now),
    ).toMatchObject({
      ok: true,
      waived_count: 1,
      waiver_notices: [
        {
          subject_id: "provider-response",
          owner: "pm-provider",
          expires_at: "2026-08-18T00:00:00.000Z",
          days_remaining: 2,
        },
      ],
    });
    // Exactly the window length away is outside it; absent and zero windows report nothing.
    for (const window of [2, 0, undefined]) {
      expect(
        evaluateBoundaryFixtures(
          { ...registry, waiver_notice_days: window },
          fixtures,
          now,
        ).waiver_notices,
      ).toEqual([]);
    }
    // An expired waiver is a finding, never a notice.
    expect(
      evaluateBoundaryFixtures(
        { ...registry, waiver_notice_days: 30 },
        fixtures,
        new Date("2026-08-19T00:00:00.000Z"),
      ),
    ).toMatchObject({
      ok: false,
      waiver_notices: [],
      findings: [{ boundary_id: "provider-response", kind: "expired_waiver" }],
    });
  });

  it("rejects a notice window that is not a whole number of days within bounds", () => {
    for (const window of [-1, 1.5, MAX_WAIVER_NOTICE_DAYS + 1, "14"]) {
      expect(
        evaluateBoundaryFixtures(
          { ...registry, waiver_notice_days: window as number },
          {},
        ),
      ).toMatchObject({
        ok: false,
        waiver_notices: [],
        findings: [{ boundary_id: "registry", kind: "invalid_registry" }],
      });
    }
    expect(isWaiverNoticeDays(0)).toBe(true);
    expect(isWaiverNoticeDays(MAX_WAIVER_NOTICE_DAYS)).toBe(true);
    expect(isWaiverNoticeDays(Number.NaN)).toBe(false);
  });

  it("builds notices only for valid future expiries and orders them soonest first", () => {
    const nowMs = Date.parse("2026-08-16T00:00:00.000Z");
    expect(waiverNoticeFor("a", "o", "not-a-date", nowMs, 14)).toBeUndefined();
    expect(
      waiverNoticeFor("a", "o", "2026-08-15T23:59:59.999Z", nowMs, 14),
    ).toBeUndefined();
    expect(
      waiverNoticeFor("a", "o", "2026-08-16T06:00:00.000Z", nowMs, 1),
    ).toEqual({
      subject_id: "a",
      owner: "o",
      expires_at: "2026-08-16T06:00:00.000Z",
      days_remaining: 0,
    });
    const notice = (subject_id: string, expires_at: string) => ({
      subject_id,
      owner: "o",
      expires_at,
      days_remaining: 0,
    });
    expect(
      sortWaiverNotices([
        notice("z", "2026-08-20T00:00:00.000Z"),
        notice("b", "2026-08-17T00:00:00Z"),
        notice("a", "2026-08-17T00:00:00.000Z"),
      ]).map((entry) => entry.subject_id),
    ).toEqual(["a", "b", "z"]);
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
          {
            id: "timezone-free",
            producer: "provider",
            consumer: "adapter",
            format: "JSON",
            waiver_reason: "Temporary",
            waiver_owner: "pm-owner",
            waiver_expires_at: "2026-08-18T00:00:00",
          },
        ],
      },
      {},
      new Date("2026-08-16T00:00:00.000Z"),
    );
    expect(report.findings.map((finding) => finding.kind)).toEqual([
      "expired_waiver",
      "invalid_waiver",
      "invalid_waiver",
    ]);
    expect(report.waived_count).toBe(0);
  });
});
