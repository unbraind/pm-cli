/**
 * @module sdk/governance/assurance-presets
 *
 * Supplies readable assurance starter bundles and observation-derived proposals
 * without introducing privileged evaluation semantics.
 */
import {
  evaluateMeasurement,
  putAssuranceDeclaration,
  putAssuranceDeclarationBundle,
  type AssuranceAssertionDefinition,
  type AssuranceBundleMutationReceipt,
  type AssuranceDeclarationBundle,
  type AssuranceEnforcement,
  type AssuranceEvaluationContext,
  type AssuranceMeasurementDefinition,
  type AssuranceScope,
} from "./assurance.js";

/** Built-in project shapes that can acquire a quality contract in one command. */
export const ASSURANCE_PRESET_IDS = [
  "software-delivery",
  "research",
  "agent-evaluation",
  "operations",
] as const;

/** Stable built-in assurance preset id. */
export type AssurancePresetId = (typeof ASSURANCE_PRESET_IDS)[number];

/** Readable preset bundle before or after application. */
export interface AssurancePreset {
  /** Stable preset id. */
  id: AssurancePresetId;
  /** Human-readable project shape. */
  title: string;
  /** Why the initial contract is useful. */
  description: string;
  /** Ordinary declarations that become editable workspace data. */
  declarations: AssuranceDeclarationBundle;
}

/** One observe-level candidate produced from authoritative workspace state. */
export interface AssuranceDerivedProposal {
  /** Stable proposal id. */
  id: string;
  /** Population used to calculate the proposed threshold. */
  population_size: number;
  /** Scope applied while measuring. */
  scope: AssuranceScope;
  /** Observed value proposed as the initial ceiling. */
  observed: number;
  /** Ordinary declarations created only after explicit acceptance. */
  declarations: AssuranceDeclarationBundle;
}

function assertion(
  id: string,
  measurementId: string,
  ownerItemId: string,
  ceiling: number,
  enforcement: AssuranceEnforcement,
): AssuranceAssertionDefinition {
  return {
    id,
    measurement_id: measurementId,
    owner_item_id: ownerItemId,
    scope: { kind: "active" },
    ceiling,
    lifetime: "hold",
    enforcement,
    negative_control: {
      cases: [
        { observed: ceiling, expected: "pass" },
        { observed: ceiling + 1, expected: "fail" },
      ],
    },
  };
}

function evidencePreset(
  id: AssurancePresetId,
  title: string,
  description: string,
  ownerItemId: string,
  links: Array<"files" | "tests" | "docs">,
): AssurancePreset {
  const prefix = `preset-${id}`;
  const measurements = links.map<AssuranceMeasurementDefinition>((link) => ({
    id: `${prefix}-missing-${link}`,
    description: `Active items missing ${link} evidence.`,
    source: { kind: "links", link, state: "missing" },
  }));
  const assertions = measurements.map((measurement) =>
    assertion(`${measurement.id}-zero`, measurement.id, ownerItemId, 0, "warn"),
  );
  return {
    id,
    title,
    description,
    declarations: {
      measurements,
      assertions,
      gates: [
        {
          id: `${prefix}-readiness`,
          description,
          assertion_ids: assertions.map((entry) => entry.id),
          triggers: ["ci", "scheduled"],
        },
      ],
    },
  };
}

/** Materialize one built-in preset as ordinary declarations owned by a pm item. */
export function createAssurancePreset(
  id: AssurancePresetId,
  ownerItemId: string,
): AssurancePreset {
  if (id === "software-delivery") {
    return evidencePreset(
      id,
      "Software delivery",
      "Warn when active delivery work lacks executable tests or documentation.",
      ownerItemId,
      ["tests", "docs"],
    );
  }
  if (id === "research") {
    return evidencePreset(
      id,
      "Research",
      "Warn when active research work lacks reproducibility files or documentation.",
      ownerItemId,
      ["files", "docs"],
    );
  }
  if (id === "agent-evaluation") {
    return evidencePreset(
      id,
      "Agent evaluation",
      "Warn when active evaluation work lacks executable scenarios or recorded artifacts.",
      ownerItemId,
      ["tests", "files"],
    );
  }
  return evidencePreset(
    id,
    "Operations",
    "Warn when active operational work lacks runbook documentation or repair evidence.",
    ownerItemId,
    ["docs", "files"],
  );
}

/** Apply one preset atomically; a second identical application is idempotent. */
export function applyAssurancePreset(
  pmRoot: string,
  id: AssurancePresetId,
  ownerItemId: string,
  options: { author?: string; message?: string } = {},
): Promise<AssuranceBundleMutationReceipt> {
  return putAssuranceDeclarationBundle(
    pmRoot,
    createAssurancePreset(id, ownerItemId).declarations,
    options,
  );
}

/** Propose active-scope evidence ceilings from the record without persisting them. */
export async function deriveAssuranceProposals(
  context: AssuranceEvaluationContext,
  ownerItemId: string,
): Promise<AssuranceDerivedProposal[]> {
  const terminalStatuses = new Set(
    context.terminal_statuses ?? ["closed", "canceled"],
  );
  const activeContext = {
    ...context,
    items: context.items.filter((item) => !terminalStatuses.has(item.status)),
  };
  const proposals = await Promise.all(
    (["files", "tests", "docs"] as const).map(
      async (link): Promise<AssuranceDerivedProposal> => {
        const measurement: AssuranceMeasurementDefinition = {
          id: `derived-active-missing-${link}`,
          description: `Observed active items missing ${link} evidence.`,
          source: { kind: "links", link, state: "missing" },
        };
        const measured = await evaluateMeasurement(measurement, activeContext);
        const observed = measured.value as number;
        const derivedAssertion = assertion(
          `${measurement.id}-ceiling`,
          measurement.id,
          ownerItemId,
          observed,
          "observe",
        );
        const id = `active-missing-${link}`;
        return {
          id,
          population_size: activeContext.items.length,
          scope: { kind: "active" } as const,
          observed,
          declarations: {
            measurements: [measurement],
            assertions: [derivedAssertion],
            gates: [
              {
                id: `derived-${id}`,
                description: `Observe the accepted ${link} evidence baseline.`,
                assertion_ids: [derivedAssertion.id],
                triggers: ["ci", "scheduled"],
              },
            ],
          },
        };
      },
    ),
  );
  return proposals;
}

/** Accept all derived proposals in one audited registry transaction. */
export function acceptAssuranceProposals(
  pmRoot: string,
  proposals: readonly AssuranceDerivedProposal[],
  options: { author?: string; message?: string } = {},
): Promise<AssuranceBundleMutationReceipt> {
  return putAssuranceDeclarationBundle(
    pmRoot,
    {
      measurements: proposals.flatMap(
        (proposal) => proposal.declarations.measurements,
      ),
      assertions: proposals.flatMap(
        (proposal) => proposal.declarations.assertions,
      ),
      gates: proposals.flatMap((proposal) => proposal.declarations.gates),
    },
    options,
  );
}

/** Promote one assertion by exactly one enforcement level and audit the transition. */
export async function promoteAssuranceAssertion(
  pmRoot: string,
  definition: AssuranceAssertionDefinition,
  enforcement: Exclude<AssuranceEnforcement, "observe">,
  options: { author?: string; message?: string } = {},
): Promise<Awaited<ReturnType<typeof putAssuranceDeclaration>>> {
  const expected = definition.enforcement === "observe" ? "warn" : "block";
  if (definition.enforcement === "block" || enforcement !== expected) {
    throw new TypeError(
      `assurance assertion ${definition.id} promotion must be ${definition.enforcement} -> ${expected}`,
    );
  }
  return putAssuranceDeclaration(
    pmRoot,
    "assertion",
    { ...definition, enforcement },
    {
      ...options,
      message:
        options.message ??
        `Promote assurance assertion ${definition.id} from ${definition.enforcement} to ${enforcement}`,
    },
  );
}
