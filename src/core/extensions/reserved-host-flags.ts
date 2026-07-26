/**
 * @module core/extensions/reserved-host-flags
 *
 * Declares the pm host flags that extension commands must never shadow.
 */

/** Describes one host-owned flag spelling reserved from extension registration. */
export interface ReservedExtensionHostFlag {
  /** Canonical long flag owned by the pm host. */
  flag: string;
  /** Compatibility aliases that are equally host-owned. */
  aliases?: readonly string[];
  /** Optional value label retained by the public CLI contract projection. */
  value_name?: string;
}

/** Host-owned flags inherited by every subcommand, including extension commands. */
export const RESERVED_EXTENSION_HOST_FLAGS: readonly ReservedExtensionHostFlag[] =
  Object.freeze([
    { flag: "--json" },
    { flag: "--lean" },
    { flag: "--quiet" },
    { flag: "--no-changed-fields" },
    { flag: "--full-changed-fields" },
    { flag: "--id-only" },
    { flag: "--pm-path", aliases: ["--path"] },
    { flag: "--no-extensions" },
    { flag: "--no-pager" },
    { flag: "--profile" },
    { flag: "--help" },
    { flag: "--author", value_name: "id" },
  ]);

/** Every canonical and aliased host flag spelling reserved from extensions. */
export const RESERVED_EXTENSION_HOST_FLAG_NAMES: ReadonlySet<string> = new Set(
  RESERVED_EXTENSION_HOST_FLAGS.flatMap((definition) => [
    definition.flag,
    ...(definition.aliases ?? []),
  ]),
);
