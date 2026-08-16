/**
 * @module sdk/boundary-fixtures
 *
 * Validates captured external-boundary samples and explicit time-bounded
 * waivers without allowing production code to manufacture its own fixtures.
 */

/** Evidence source accepted for a captured boundary sample. */
export const BOUNDARY_FIXTURE_CAPTURE_SOURCES = [
  "captured_redacted",
  "captured_verbatim",
] as const;

/** Captured boundary evidence source. */
export type BoundaryFixtureCaptureSource =
  (typeof BOUNDARY_FIXTURE_CAPTURE_SOURCES)[number];

/** Inventory record backed by a committed captured sample. */
export interface CapturedBoundaryRecord {
  /** Stable external-boundary identifier. */
  id: string;
  /** Production component that emits or obtains the value. */
  producer: string;
  /** Production component that parses or consumes the value. */
  consumer: string;
  /** Concise serialized-format description. */
  format: string;
  /** Relative path to a committed JSON fixture. */
  fixture_path: string;
}

/** Inventory record explicitly waived until a bounded expiry. */
export interface WaivedBoundaryRecord {
  /** Stable external-boundary identifier. */
  id: string;
  /** Production component that emits or obtains the value. */
  producer: string;
  /** Production component that parses or consumes the value. */
  consumer: string;
  /** Concise serialized-format description. */
  format: string;
  /** Concrete reason a safe captured fixture is not available. */
  waiver_reason: string;
  /** Accountable PM item or team. */
  waiver_owner: string;
  /** ISO timestamp after which the waiver fails closed. */
  waiver_expires_at: string;
}

/** One externally generated or consumed boundary inventory entry. */
export type BoundaryInventoryRecord =
  | CapturedBoundaryRecord
  | WaivedBoundaryRecord;

/** Versioned project boundary inventory. */
export interface BoundaryFixtureRegistry {
  /** Serialized registry format. */
  version: 1;
  /** Human-readable statement of what source surfaces were inventoried. */
  inventory_scope: string;
  /** Captured or explicitly waived boundary records. */
  boundaries: BoundaryInventoryRecord[];
}

/** Required shape of a committed captured boundary sample. */
export interface BoundaryFixtureSample {
  /** Serialized fixture format. */
  version: 1;
  /** Inventory boundary id proved by this sample. */
  boundary_id: string;
  /** Captured evidence classification; self-generated is intentionally absent. */
  capture_source: BoundaryFixtureCaptureSource;
  /** Where and how the original value was observed. */
  capture_provenance: string;
  /** Redactions applied before committing the sample. */
  redactions: string[];
  /** Redacted external input. */
  input: unknown;
  /** Redacted observed boundary value. */
  observed: unknown;
}

/** Stable boundary-fixture governance finding. */
export interface BoundaryFixtureFinding {
  /** Boundary id, or registry for registry-wide defects. */
  boundary_id: string;
  /** Machine-readable failure kind. */
  kind:
    | "invalid_registry"
    | "duplicate_boundary"
    | "invalid_boundary"
    | "missing_fixture"
    | "invalid_fixture"
    | "fixture_boundary_mismatch"
    | "unsafe_fixture"
    | "invalid_waiver"
    | "expired_waiver";
  /** Actionable explanation. */
  detail: string;
}

/** Complete captured-boundary governance report. */
export interface BoundaryFixtureReport {
  /** Whether every inventoried boundary has safe current evidence. */
  ok: boolean;
  /** Total inventoried boundaries. */
  boundary_count: number;
  /** Boundaries backed by committed captured samples. */
  captured_count: number;
  /** Boundaries carrying live explicit waivers. */
  waived_count: number;
  /** Stable sorted failures. */
  findings: BoundaryFixtureFinding[];
}

const SECRET_OR_PRIVATE_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "home directory", pattern: /(?:\/home\/|\/Users\/)[^/\s"']+/u },
  { label: "GitHub token", pattern: /\b(?:gh[oprsu]_[A-Za-z0-9_]{20,})\b/u },
  { label: "npm token", pattern: /\bnpm_[A-Za-z0-9]{20,}\b/u },
  { label: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u },
];

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateSample(
  boundary: CapturedBoundaryRecord,
  sample: unknown,
): BoundaryFixtureFinding[] {
  if (typeof sample !== "object" || sample === null || Array.isArray(sample)) {
    return [
      {
        boundary_id: boundary.id,
        kind: "invalid_fixture",
        detail: `${boundary.fixture_path} must contain a JSON object.`,
      },
    ];
  }
  const fixture = sample as Partial<BoundaryFixtureSample>;
  const findings: BoundaryFixtureFinding[] = [];
  if (fixture.boundary_id !== boundary.id) {
    findings.push({
      boundary_id: boundary.id,
      kind: "fixture_boundary_mismatch",
      detail: `${boundary.fixture_path} names ${String(fixture.boundary_id)} instead of ${boundary.id}.`,
    });
  }
  if (
    fixture.version !== 1 ||
    !BOUNDARY_FIXTURE_CAPTURE_SOURCES.includes(
      fixture.capture_source as BoundaryFixtureCaptureSource,
    ) ||
    !nonEmpty(fixture.capture_provenance) ||
    !Array.isArray(fixture.redactions) ||
    !fixture.redactions.every(nonEmpty) ||
    !("input" in fixture) ||
    !("observed" in fixture)
  ) {
    findings.push({
      boundary_id: boundary.id,
      kind: "invalid_fixture",
      detail: `${boundary.fixture_path} lacks captured provenance, redaction metadata, input, or observed output.`,
    });
  }
  const serialized = JSON.stringify(sample);
  for (const sensitive of SECRET_OR_PRIVATE_PATTERNS) {
    if (sensitive.pattern.test(serialized)) {
      findings.push({
        boundary_id: boundary.id,
        kind: "unsafe_fixture",
        detail: `${boundary.fixture_path} contains a possible ${sensitive.label}.`,
      });
    }
  }
  return findings;
}

function evaluateBoundaryRecord(
  boundary: BoundaryInventoryRecord,
  fixtures: Readonly<Record<string, unknown>>,
  nowMs: number,
): { captured: number; waived: number; findings: BoundaryFixtureFinding[] } {
  if (
    !nonEmpty(boundary.id) ||
    !nonEmpty(boundary.producer) ||
    !nonEmpty(boundary.consumer) ||
    !nonEmpty(boundary.format)
  ) {
    return {
      captured: 0,
      waived: 0,
      findings: [
        {
          boundary_id: boundary.id || "unknown",
          kind: "invalid_boundary",
          detail: "Each boundary requires non-empty id, producer, consumer, and format.",
        },
      ],
    };
  }
  if ("fixture_path" in boundary) {
    const sample = fixtures[boundary.fixture_path];
    return {
      captured: 1,
      waived: 0,
      findings:
        nonEmpty(boundary.fixture_path) && boundary.fixture_path in fixtures
          ? validateSample(boundary, sample)
          : [
              {
                boundary_id: boundary.id,
                kind: "missing_fixture",
                detail: `Boundary ${boundary.id} fixture ${String(boundary.fixture_path)} is missing.`,
              },
            ],
    };
  }
  const expiresAt = Date.parse(boundary.waiver_expires_at);
  const validWaiver =
    nonEmpty(boundary.waiver_reason) &&
    nonEmpty(boundary.waiver_owner) &&
    Number.isFinite(expiresAt);
  return {
    captured: 0,
    waived: 1,
    findings: !validWaiver
      ? [
          {
            boundary_id: boundary.id,
            kind: "invalid_waiver",
            detail: `Boundary ${boundary.id} waiver requires reason, owner, and ISO expiry.`,
          },
        ]
      : expiresAt < nowMs
        ? [
            {
              boundary_id: boundary.id,
              kind: "expired_waiver",
              detail: `Boundary ${boundary.id} waiver expired at ${boundary.waiver_expires_at}.`,
            },
          ]
        : [],
  };
}

/** Validate an untrusted boundary registry and its already-loaded JSON samples. */
export function evaluateBoundaryFixtures(
  registry: BoundaryFixtureRegistry,
  fixtures: Readonly<Record<string, unknown>>,
  now = new Date(),
): BoundaryFixtureReport {
  const findings: BoundaryFixtureFinding[] = [];
  if (
    registry.version !== 1 ||
    !nonEmpty(registry.inventory_scope) ||
    !Array.isArray(registry.boundaries)
  ) {
    return {
      ok: false,
      boundary_count: 0,
      captured_count: 0,
      waived_count: 0,
      findings: [
        {
          boundary_id: "registry",
          kind: "invalid_registry",
          detail: "Boundary registry requires version 1, inventory_scope, and boundaries.",
        },
      ],
    };
  }
  const ids = new Set<string>();
  let capturedCount = 0;
  let waivedCount = 0;
  for (const boundary of registry.boundaries) {
    if (ids.has(boundary.id)) {
      findings.push({
        boundary_id: boundary.id,
        kind: "duplicate_boundary",
        detail: `Boundary ${boundary.id} is inventoried more than once.`,
      });
      continue;
    }
    ids.add(boundary.id);
    const evaluated = evaluateBoundaryRecord(boundary, fixtures, now.getTime());
    capturedCount += evaluated.captured;
    waivedCount += evaluated.waived;
    findings.push(...evaluated.findings);
  }
  findings.sort((left, right) =>
    left.boundary_id !== right.boundary_id
      ? left.boundary_id.localeCompare(right.boundary_id)
      : left.kind.localeCompare(right.kind),
  );
  return {
    ok: findings.length === 0,
    boundary_count: registry.boundaries.length,
    captured_count: capturedCount,
    waived_count: waivedCount,
    findings,
  };
}
