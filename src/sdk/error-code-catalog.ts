/**
 * @module sdk/error-code-catalog
 *
 * Defines the stable, discoverable error vocabulary used across CLI, SDK, MCP,
 * packages, and generated contract surfaces.
 */

/** Compatibility promise attached to a machine-readable error code. */
export type PmErrorCodeStability = "provisional" | "stable";

/** Semantic process-exit class shared by shell and SDK consumers. */
export type PmErrorCodeClass =
  | "generic_failure"
  | "usage"
  | "not_found"
  | "conflict"
  | "dependency_failed";

/** One externally observable refusal state and its executable entrypoint probe. */
export interface PmRefusalStateContract {
  /** Stable semantic state owned by the error code. */
  state: string;
  /** Stable probe identifier implemented by the entrypoint conformance suite. */
  probe_id: string;
  /** Public command roots through which the state must remain reachable. */
  entrypoints: string[];
  /** Exit class expected when the probe reaches the state. */
  expected_exit_class: PmErrorCodeClass;
}

/** Stable shell exit-code taxonomy shared by every structured error. */
export const PM_ERROR_CODE_EXIT_CLASS_CONTRACTS = [
  { exit_code: 1, class: "generic_failure" },
  { exit_code: 2, class: "usage" },
  { exit_code: 3, class: "not_found" },
  { exit_code: 4, class: "conflict" },
  { exit_code: 5, class: "dependency_failed" },
] as const satisfies readonly {
  exit_code: 1 | 2 | 3 | 4 | 5;
  class: PmErrorCodeClass;
}[];

const ERROR_CLASS_BY_EXIT_CODE = new Map(
  PM_ERROR_CODE_EXIT_CLASS_CONTRACTS.map(
    (contract) => [contract.exit_code, contract.class] as const,
  ),
);

/** Normalize a declared non-empty string set into stable contract order. */
function normalizeContractList(values: readonly string[]): string[] {
  return [
    ...new Set(values.map((value) => value.trim()).filter(Boolean)),
  ].sort();
}

/** One machine-readable error and its portable recovery contract. */
export interface PmErrorCodeContract {
  /** Stable snake_case identifier. */
  code: string;
  /** Concise description of the failed condition. */
  meaning: string;
  /** Compatibility tier for package consumers. */
  stability: PmErrorCodeStability;
  /** Process exit code emitted by the CLI transport. */
  exit_code: 1 | 2 | 3 | 4 | 5;
  /** Semantic class represented by the process exit code. */
  class: PmErrorCodeClass;
  /** Actionable caller recovery guidance. */
  recovery: string;
  /** Subsystems that can emit the code. */
  sources: string[];
  /** CLI command roots inferred from executable declaration ownership. */
  emitting_commands: string[];
  /** Canonical machine identifier for this compatibility group. */
  canonical_code?: string;
  /** Stable compatibility spellings that resolve to this canonical code. */
  aliases?: string[];
  /** Observable states this code claims, each backed by a real-entrypoint probe. */
  owned_states?: PmRefusalStateContract[];
}

function normalizeOwnedStates(
  states: readonly PmRefusalStateContract[] | undefined,
): PmRefusalStateContract[] {
  if (!states) return [];
  const seenStates = new Set<string>();
  const seenProbes = new Set<string>();
  return states
    .map((state) => {
      const normalizedState = state.state.trim();
      const probeId = state.probe_id.trim();
      const entrypoints = normalizeContractList(state.entrypoints);
      if (
        !/^[a-z][a-z0-9_]*$/.test(normalizedState) ||
        !/^[a-z][a-z0-9-]*$/.test(probeId) ||
        entrypoints.length === 0 ||
        seenStates.has(normalizedState) ||
        seenProbes.has(probeId)
      ) {
        throw new TypeError("Invalid pm refusal state contract");
      }
      seenStates.add(normalizedState);
      seenProbes.add(probeId);
      return {
        state: normalizedState,
        probe_id: probeId,
        entrypoints,
        expected_exit_class: state.expected_exit_class,
      };
    })
    .sort((left, right) => left.state.localeCompare(right.state));
}

function isValidNormalizedErrorCodeContract(
  declaration: PmErrorCodeContract,
  sources: readonly string[],
  emittingCommands: readonly string[],
  canonicalCode: string,
  aliases: readonly string[],
): boolean {
  return ![
    [1, 2, 3, 4, 5].includes(declaration.exit_code),
    declaration.meaning.trim().length > 0,
    declaration.recovery.trim().length > 0,
    sources.length > 0,
    emittingCommands.length > 0,
    /^[a-z][a-z0-9_]*$/.test(canonicalCode),
    aliases.every((alias) => /^[a-z][a-z0-9_]*$/.test(alias)),
    ERROR_CLASS_BY_EXIT_CODE.get(declaration.exit_code) === declaration.class,
  ].includes(false);
}

function resolveCanonicalErrorCodeDeclaration(
  declaration: Readonly<PmErrorCodeContract>,
  byCode: ReadonlyMap<string, Readonly<PmErrorCodeContract>>,
): Readonly<PmErrorCodeContract> {
  let current = declaration;
  const path = new Set<string>();
  while (current.canonical_code !== current.code) {
    if (path.has(current.code)) {
      throw new TypeError(
        `Alias cycle in pm error code catalog: ${declaration.code}`,
      );
    }
    path.add(current.code);
    const target = byCode.get(current.canonical_code!);
    if (!target) {
      throw new TypeError(
        `Invalid pm error code contract: ${declaration.code}`,
      );
    }
    current = target;
  }
  return current;
}

function validateErrorCodeAliases(
  declarations: readonly Readonly<PmErrorCodeContract>[],
): void {
  const byCode = new Map(declarations.map((entry) => [entry.code, entry]));
  for (const declaration of declarations) {
    const canonical = resolveCanonicalErrorCodeDeclaration(declaration, byCode);
    if (
      canonical.exit_code !== declaration.exit_code ||
      canonical.class !== declaration.class
    ) {
      throw new TypeError(
        `Alias transport mismatch for pm error code: ${declaration.code}`,
      );
    }
    const expectedAliases = declarations
      .filter(
        (candidate) =>
          candidate.code !== canonical.code &&
          candidate.canonical_code === canonical.code,
      )
      .map((candidate) => candidate.code)
      .sort();
    if (
      declaration.code === canonical.code
        ? JSON.stringify(declaration.aliases) !==
          JSON.stringify(expectedAliases)
        : declaration.aliases!.length > 0
    ) {
      throw new TypeError(
        `Invalid pm error code contract: ${declaration.code}`,
      );
    }
  }
}

/** Validate, normalize, sort, and freeze an error-code catalog. */
export function definePmErrorCodeCatalog(
  declarations: readonly PmErrorCodeContract[],
): readonly PmErrorCodeContract[] {
  const seen = new Set<string>();
  const normalized = declarations.map((declaration) => {
    const code = declaration.code.trim();
    if (!/^[a-z][a-z0-9_]*$/.test(code)) {
      throw new TypeError(
        `Invalid pm error code: ${JSON.stringify(declaration.code)}`,
      );
    }
    if (seen.has(code)) {
      throw new TypeError(`Duplicate pm error code: ${code}`);
    }
    seen.add(code);
    const sources = normalizeContractList(declaration.sources);
    const emittingCommands = normalizeContractList(
      declaration.emitting_commands,
    );
    const canonicalCode = (declaration.canonical_code ?? code).trim();
    const aliases = normalizeContractList(declaration.aliases ?? []);
    const ownedStates = normalizeOwnedStates(declaration.owned_states);
    if (
      !isValidNormalizedErrorCodeContract(
        declaration,
        sources,
        emittingCommands,
        canonicalCode,
        aliases,
      )
    ) {
      throw new TypeError(`Invalid pm error code contract: ${code}`);
    }
    if (
      ownedStates.some(
        (state) => state.expected_exit_class !== declaration.class,
      )
    ) {
      throw new TypeError(`Invalid pm refusal state exit class: ${code}`);
    }
    return Object.freeze({
      ...declaration,
      code,
      meaning: declaration.meaning.trim(),
      recovery: declaration.recovery.trim(),
      sources,
      emitting_commands: emittingCommands,
      canonical_code: canonicalCode,
      aliases,
      owned_states: ownedStates,
    });
  });
  validateErrorCodeAliases(normalized);
  return Object.freeze(
    normalized.sort((left, right) => left.code.localeCompare(right.code)),
  );
}

/** Resolve an emitted code through its stable compatibility alias group. */
export function resolveCanonicalPmErrorCodeContract(
  code: string,
  catalog: readonly PmErrorCodeContract[],
): PmErrorCodeContract {
  const emitted = resolvePmErrorCodeContract(code, catalog);
  return resolvePmErrorCodeContract(
    emitted.canonical_code ?? emitted.code,
    catalog,
  );
}

/** Resolve one declared error contract and fail closed for unknown vocabulary. */
export function resolvePmErrorCodeContract(
  code: string,
  catalog: readonly PmErrorCodeContract[],
): PmErrorCodeContract {
  const normalized = code.trim();
  const contract = catalog.find((entry) => entry.code === normalized);
  if (!contract) {
    throw new TypeError(`Unknown pm error code "${normalized}"`);
  }
  return contract;
}
