import { describe, expect, it } from "vitest";
import {
  PM_READ_OUTPUT_CONTINUATION_FINGERPRINT_POLICIES,
  readOutputCollectionFingerprint,
} from "../../../../src/sdk/read-output/continuation.js";
import {
  applyReadOutputDimensions,
  encodeReadOutputContinuationCursor,
} from "../../../../src/sdk/read-output-contracts.js";

describe("read-output continuation fingerprints", () => {
  const healthChecks = [
    {
      name: "telemetry",
      status: "ok",
      details: {
        enabled: true,
        capture_level: "standard",
        endpoint: "https://telemetry.example.test/v1/events",
        env_overrides: { endpoint: false },
        endpoint_probe: { attempted: false },
        queue_entries: 0,
        last_attempted_flush_at: "2026-08-24T12:00:00.000Z",
        last_successful_flush_at: "2026-08-24T12:00:00.000Z",
      },
    },
    { name: "storage", status: "ok", details: { items: 2_539 } },
  ];

  it("resumes after telemetry lifecycle details refresh", () => {
    const cursor = encodeReadOutputContinuationCursor({
      command: "health",
      path: "checks",
      offset: 1,
      total_rows: healthChecks.length,
      fingerprint: readOutputCollectionFingerprint(
        "checks",
        healthChecks,
        "health",
      ),
    });
    const resumed = applyReadOutputDimensions(
      "health",
      { outputCursor: cursor },
      {
        checks: [
          {
            ...healthChecks[0],
            details: {
              ...healthChecks[0]!.details,
              queue_exists: true,
              queue_entries: 3,
              queue_rows_total: 3,
              queue_size_bytes: 1_024,
              pending_otel_spans: 2,
              last_attempted_flush_at: "2026-08-24T12:01:00.000Z",
              last_successful_flush_at: "2026-08-24T12:01:00.000Z",
            },
          },
          healthChecks[1],
        ],
        row_contract: {
          command: "health",
          row_kind: "collection",
          row_keys: ["checks"],
          continuation_row_keys: ["checks"],
          fields: "unsupported",
        },
      },
    );

    expect(resumed.checks).toEqual([healthChecks[1]]);
  });

  it("still rejects nonvolatile health changes and identical keys on other commands", () => {
    const healthCursor = encodeReadOutputContinuationCursor({
      command: "health",
      path: "checks",
      offset: 1,
      total_rows: healthChecks.length,
      fingerprint: readOutputCollectionFingerprint(
        "checks",
        healthChecks,
        "health",
      ),
    });
    expect(() =>
      applyReadOutputDimensions(
        "health",
        { outputCursor: healthCursor },
        {
          checks: [
            healthChecks[0],
            {
              ...healthChecks[1],
              details: { items: 2_540 },
            },
          ],
          row_contract: {
            command: "health",
            row_kind: "collection",
            row_keys: ["checks"],
            continuation_row_keys: ["checks"],
            fields: "unsupported",
          },
        },
      ),
    ).toThrow("no longer matches");

    expect(() =>
      applyReadOutputDimensions(
        "health",
        { outputCursor: healthCursor },
        {
          checks: [
            healthChecks[0],
            {
              ...healthChecks[1],
              details: {
                ...healthChecks[1]!.details,
                nested: {
                  name: "telemetry",
                  details: { queue_entries: 1 },
                },
              },
            },
          ],
          row_contract: {
            command: "health",
            row_kind: "collection",
            row_keys: ["checks"],
            continuation_row_keys: ["checks"],
            fields: "unsupported",
          },
        },
      ),
    ).toThrow("no longer matches");

    for (const changedDetails of [
      { ...healthChecks[0]!.details, enabled: false },
      { ...healthChecks[0]!.details, capture_level: "minimal" },
      {
        ...healthChecks[0]!.details,
        endpoint: "https://attacker.example.test/v1/events",
      },
      {
        ...healthChecks[0]!.details,
        env_overrides: { endpoint: true },
      },
      {
        ...healthChecks[0]!.details,
        endpoint_probe: { attempted: true, ok: false },
      },
      {
        ...healthChecks[0]!.details,
        last_failed_flush_error: "certificate validation failed",
      },
    ]) {
      expect(() =>
        applyReadOutputDimensions(
          "health",
          { outputCursor: healthCursor },
          {
            checks: [
              { ...healthChecks[0], details: changedDetails },
              healthChecks[1],
            ],
            row_contract: {
              command: "health",
              row_kind: "collection",
              row_keys: ["checks"],
              continuation_row_keys: ["checks"],
              fields: "unsupported",
            },
          },
        ),
      ).toThrow("no longer matches");
    }

    expect(() =>
      applyReadOutputDimensions(
        "health",
        { outputCursor: healthCursor },
        {
          checks: [
            { ...healthChecks[0], status: "warn" },
            healthChecks[1],
          ],
          row_contract: {
            command: "health",
            row_kind: "collection",
            row_keys: ["checks"],
            continuation_row_keys: ["checks"],
            fields: "unsupported",
          },
        },
      ),
    ).toThrow("no longer matches");

    expect(
      readOutputCollectionFingerprint("items", healthChecks, "list"),
    ).not.toBe(
      readOutputCollectionFingerprint(
        "items",
        [
          {
            ...healthChecks[0],
            details: {
              ...healthChecks[0]!.details,
              last_attempted_flush_at: "2026-08-24T12:01:00.000Z",
            },
          },
          healthChecks[1],
        ],
        "list",
      ),
    );

    expect(readOutputCollectionFingerprint("checks", healthChecks)).not.toBe(
      readOutputCollectionFingerprint(
        "checks",
        [
          {
            ...healthChecks[0],
            details: {
              ...healthChecks[0]!.details,
              last_attempted_flush_at: "2026-08-24T12:01:00.000Z",
            },
          },
          healthChecks[1],
        ],
      ),
    );
  });

  it("publishes the narrow stable-snapshot policy as an immutable SDK contract", () => {
    expect(PM_READ_OUTPUT_CONTINUATION_FINGERPRINT_POLICIES.health).toEqual({
      version: 3,
      paths: ["checks"],
      ignored_detail_field_names_by_row: {
        telemetry: [
          "queue_draining",
          "queue_entries",
          "queue_exists",
          "queue_high_retry_entries",
          "queue_invalid_rows",
          "queue_max_attempts",
          "queue_rows_total",
          "queue_size_bytes",
          "pending_otel_spans",
          "last_attempted_flush_at",
          "last_failed_flush_at",
          "last_otel_attempt_at",
          "last_otel_failure_at",
          "last_otel_success_at",
          "last_successful_flush_at",
        ],
      },
      guarantee: "nonvolatile_snapshot_and_stable_configuration",
    });
    expect(
      Object.isFrozen(PM_READ_OUTPUT_CONTINUATION_FINGERPRINT_POLICIES.health),
    ).toBe(true);
  });

  it("keeps row exclusions scoped across defensive collection shapes", () => {
    const defensiveRows: unknown[] = [
      null,
      ["nested", { queue_entries: 1 }],
      { name: 42, details: { nested: ["value"] } },
      { name: "telemetry", details: "opaque" },
    ];
    expect(
      readOutputCollectionFingerprint("checks", defensiveRows, "health"),
    ).not.toBe(
      readOutputCollectionFingerprint(
        "checks",
        [
          null,
          ["nested", { queue_entries: 2 }],
          { name: 42, details: { nested: ["value"] } },
          { name: "telemetry", details: "opaque" },
        ],
        "health",
      ),
    );

    expect(
      readOutputCollectionFingerprint(
        "checks",
        { name: "telemetry", details: { queue_entries: 1 } },
        "health",
      ),
    ).toBe(
      readOutputCollectionFingerprint(
        "checks",
        { name: "telemetry", details: { queue_entries: 2 } },
        "health",
      ),
    );

    for (const name of ["constructor", "toString", "__proto__"]) {
      expect(
        readOutputCollectionFingerprint(
          "checks",
          [{ name, details: { queue_entries: 1 } }],
          "health",
        ),
      ).not.toBe(
        readOutputCollectionFingerprint(
          "checks",
          [{ name, details: { queue_entries: 2 } }],
          "health",
        ),
      );
    }
  });
});
