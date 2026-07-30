/**
 * @module sdk/runtime-action-aliases
 *
 * Declares canonical native-action routes for public SDK aliases.
 */

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

const EXTENSION_ACTION_ALIASES: Record<string, SdkActionAlias> = {
  "extension-init": { action: "extension", options: { init: true } },
  "extension-install": { action: "extension", options: { install: true } },
  "extension-uninstall": { action: "extension", options: { uninstall: true } },
  "extension-explore": { action: "extension", options: { explore: true } },
  "extension-manage": { action: "extension", options: { manage: true } },
  "extension-describe": { action: "extension", options: { describe: true } },
  "extension-reload": { action: "extension", options: { reload: true } },
  "extension-doctor": { action: "extension", options: { doctor: true } },
  "extension-catalog": { action: "extension", options: { catalog: true } },
  "extension-adopt": { action: "extension", options: { adopt: true } },
  "extension-adopt-all": { action: "extension", options: { adoptAll: true } },
  "extension-activate": { action: "extension", options: { activate: true } },
  "extension-deactivate": {
    action: "extension",
    options: { deactivate: true },
  },
};

const PACKAGE_ACTION_ALIASES: Record<string, SdkActionAlias> = {
  "package-init": {
    action: "package",
    options: { init: true, vocabulary: "package" },
  },
  "package-install": {
    action: "package",
    options: { install: true, vocabulary: "package" },
  },
  "package-uninstall": {
    action: "package",
    options: { uninstall: true, vocabulary: "package" },
  },
  "package-explore": {
    action: "package",
    options: { explore: true, vocabulary: "package" },
  },
  "package-manage": {
    action: "package",
    options: { manage: true, vocabulary: "package" },
  },
  "package-describe": {
    action: "package",
    options: { describe: true, vocabulary: "package" },
  },
  "package-reload": {
    action: "package",
    options: { reload: true, vocabulary: "package" },
  },
  "package-doctor": {
    action: "package",
    options: { doctor: true, vocabulary: "package" },
  },
  "package-catalog": {
    action: "package",
    options: { catalog: true, vocabulary: "package" },
  },
  "package-adopt": {
    action: "package",
    options: { adopt: true, vocabulary: "package" },
  },
  "package-adopt-all": {
    action: "package",
    options: { adoptAll: true, vocabulary: "package" },
  },
  "package-activate": {
    action: "package",
    options: { activate: true, vocabulary: "package" },
  },
  "package-deactivate": {
    action: "package",
    options: { deactivate: true, vocabulary: "package" },
  },
};

/** Canonical action and default-option routing for every SDK alias. */
export const SDK_ACTION_ALIASES: Readonly<Record<string, SdkActionAlias>> = {
  ctx: { action: "context" },
  ...LIST_ACTION_ALIASES,
  ...EXTENSION_ACTION_ALIASES,
  ...PACKAGE_ACTION_ALIASES,
};
