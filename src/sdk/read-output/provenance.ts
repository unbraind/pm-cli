/**
 * @module sdk/read-output/provenance
 *
 * Retains private invocation-origin evidence through SDK option normalization.
 */

/** Private invocation origin shared by SDK option construction and read-output resolution. */
export const READ_OUTPUT_INVOCATION_PROVENANCE = Symbol.for(
  "pm.readOutputInvocationProvenance",
);

/** Internal evidence that distinguishes caller aliases from forwarded command options. */
export interface PmReadOutputInvocationProvenance {
  /** Canonical include modes forwarded through command-local option keys. */
  canonical_include_modes: string[];
  /** Compatibility aliases observed before defaults or canonical forwarding. */
  explicit_legacy_aliases: string[];
  /** Whether the CLI captured the complete set of caller-supplied aliases. */
  cli_invocation_observed?: boolean;
  /** Whether an SDK helper constructed every command-local option itself. */
  sdk_invocation_observed?: boolean;
}

/** Mark a complete SDK helper request so internal command options are not reported as caller aliases. */
export function markCanonicalSdkReadOutputOptions<Options extends object>(
  options: Options,
  canonicalIncludeModes: readonly string[],
): Options {
  Reflect.set(options, READ_OUTPUT_INVOCATION_PROVENANCE, {
    canonical_include_modes: [...canonicalIncludeModes],
    explicit_legacy_aliases: [],
    sdk_invocation_observed: true,
  } satisfies PmReadOutputInvocationProvenance);
  return options;
}
