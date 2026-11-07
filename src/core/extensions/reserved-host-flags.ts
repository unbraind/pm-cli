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
  /**
   * Which extension commands accept the flag (pm-gh1666). Omitted means every
   * extension command; `read_output` limits it to commands that declare
   * structured read output; `never` marks a flag that removes the command
   * itself, so per-command discovery never lists it.
   */
  extension_command_availability?: "read_output" | "never";
  /**
   * Value label for per-command discovery when the reservation deliberately
   * omits `value_name` (tracker paths consume even flag-looking values). A flag
   * with either label takes a required value; every other reserved flag is a
   * switch.
   */
  discovery_value_name?: string;
}

/** Host-owned flags inherited by every subcommand, including extension commands. */
export const RESERVED_EXTENSION_HOST_FLAGS: readonly ReservedExtensionHostFlag[] =
  Object.freeze([
    { flag: "--json" },
    { flag: "--lean" },
    { flag: "--token-accounting" },
    { flag: "--output-include", value_name: "fields", extension_command_availability: "read_output" },
    { flag: "--output-limit", value_name: "count", extension_command_availability: "read_output" },
    { flag: "--output-budget", value_name: "tokens", extension_command_availability: "read_output" },
    { flag: "--output-format", value_name: "toon|json" },
    { flag: "--output-session", value_name: "state", extension_command_availability: "read_output" },
    { flag: "--output-cursor", value_name: "cursor", extension_command_availability: "read_output" },
    { flag: "--output-row-contract", extension_command_availability: "read_output" },
    { flag: "--quiet" },
    { flag: "--no-changed-fields" },
    { flag: "--full-changed-fields" },
    { flag: "--id-only" },
    { flag: "--pm-path", aliases: ["--path"], discovery_value_name: "path" },
    { flag: "--no-extensions", extension_command_availability: "never" },
    { flag: "--no-pager" },
    { flag: "--profile" },
    { flag: "--help" },
    { flag: "--author", value_name: "id" },
    { flag: "--expect-hash", value_name: "revision" },
  ]);

/** Every canonical and aliased host flag spelling reserved from extensions. */
export const RESERVED_EXTENSION_HOST_FLAG_NAMES: ReadonlySet<string> = new Set(
  RESERVED_EXTENSION_HOST_FLAGS.flatMap((definition) => [
    definition.flag,
    ...(definition.aliases ?? []),
  ]),
);
