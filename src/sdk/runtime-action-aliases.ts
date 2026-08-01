/**
 * @module sdk/runtime-action-aliases
 *
 * Declares canonical native-action routes for public SDK aliases.
 */
import { PM_EXTENSION_PACKAGE_ACTION_SUBCOMMANDS } from "./cli-contracts/enum-contracts.js";

interface SdkActionAlias {
  action: string;
  options?: Record<string, unknown>;
}

const LIST_ACTION_ALIASES: Record<string, SdkActionAlias> = {
  "list-all": { action: "list", options: { excludeTerminal: false } },
  "list-draft": {
    action: "list",
    options: { status: "draft", excludeTerminal: false },
  },
  "list-open": {
    action: "list",
    options: { status: "open", excludeTerminal: false },
  },
  "list-in-progress": {
    action: "list",
    options: { status: "in_progress", excludeTerminal: false },
  },
  "list-blocked": {
    action: "list",
    options: { status: "blocked", excludeTerminal: false },
  },
  "list-closed": {
    action: "list",
    options: { status: "closed", excludeTerminal: false },
  },
  "list-canceled": {
    action: "list",
    options: { status: "canceled", excludeTerminal: false },
  },
};

function buildExtensionPackageActionAliases(
  action: "extension" | "package",
): Record<string, SdkActionAlias> {
  return Object.fromEntries(
    PM_EXTENSION_PACKAGE_ACTION_SUBCOMMANDS.map((subcommand) => [
      `${action}-${subcommand}`,
      {
        action,
        options: {
          [subcommand === "adopt-all" ? "adoptAll" : subcommand]: true,
          ...(action === "package" ? { vocabulary: "package" } : {}),
        },
      },
    ]),
  );
}

/** Canonical action and default-option routing for every SDK alias. */
export const SDK_ACTION_ALIASES: Readonly<Record<string, SdkActionAlias>> = {
  ctx: { action: "context" },
  ...LIST_ACTION_ALIASES,
  ...buildExtensionPackageActionAliases("extension"),
  ...buildExtensionPackageActionAliases("package"),
};
