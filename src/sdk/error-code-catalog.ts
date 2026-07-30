/**
 * @module sdk/error-code-catalog
 *
 * Defines the stable, discoverable error vocabulary used across CLI, SDK, MCP,
 * packages, and generated contract surfaces.
 */

/** Compatibility promise attached to a machine-readable error code. */
export type PmErrorCodeStability = "provisional" | "stable";

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
  /** Actionable caller recovery guidance. */
  recovery: string;
  /** Subsystems that can emit the code. */
  sources: string[];
}

/** Validate, normalize, sort, and freeze an error-code catalog. */
export function definePmErrorCodeCatalog(
  declarations: readonly PmErrorCodeContract[],
): readonly PmErrorCodeContract[] {
  const seen = new Set<string>();
  const normalized = declarations.map((declaration) => {
    const code = declaration.code.trim();
    if (!/^[a-z][a-z0-9_]*$/.test(code)) {
      throw new TypeError(`Invalid pm error code: ${JSON.stringify(declaration.code)}`);
    }
    if (seen.has(code)) {
      throw new TypeError(`Duplicate pm error code: ${code}`);
    }
    seen.add(code);
    if (
      ![1, 2, 3, 4, 5].includes(declaration.exit_code) ||
      declaration.meaning.trim().length === 0 ||
      declaration.recovery.trim().length === 0 ||
      declaration.sources.length === 0
    ) {
      throw new TypeError(`Invalid pm error code contract: ${code}`);
    }
    return Object.freeze({
      ...declaration,
      code,
      meaning: declaration.meaning.trim(),
      recovery: declaration.recovery.trim(),
      sources: [...new Set(declaration.sources.map((source) => source.trim()).filter(Boolean))].sort(),
    });
  });
  return Object.freeze(
    normalized.sort((left, right) => left.code.localeCompare(right.code)),
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
