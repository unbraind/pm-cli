/**
 * @module sdk/extension-contracts
 *
 * Publishes the stable extension capability vocabulary without loading the
 * aggregate SDK entrypoint.
 */
import {
  EXTENSION_CAPABILITY_CONTRACT,
  EXTENSION_CAPABILITY_CONTRACT_VERSION,
  EXTENSION_CAPABILITY_LEGACY_ALIASES,
  KNOWN_EXTENSION_CAPABILITIES,
  KNOWN_EXTENSION_POLICY_MODES,
  KNOWN_EXTENSION_POLICY_SURFACES,
  KNOWN_EXTENSION_SANDBOX_PROFILES,
  KNOWN_EXTENSION_TRUST_MODES,
} from "../core/extensions/loader.js";

/**
 * Canonical extension capability names accepted by pm.
 *
 * Extension manifests should declare one or more of these values in
 * `capabilities`.
 */
export const EXTENSION_CAPABILITIES = KNOWN_EXTENSION_CAPABILITIES;

/** Restricts extension capability values accepted by command, SDK, and storage contracts. */
export type ExtensionCapability = (typeof EXTENSION_CAPABILITIES)[number];

/** Canonical extension governance policy modes. */
export const EXTENSION_POLICY_MODES = KNOWN_EXTENSION_POLICY_MODES;

/** Canonical extension registration surfaces governed by policy. */
export const EXTENSION_POLICY_SURFACES = KNOWN_EXTENSION_POLICY_SURFACES;

/** Canonical extension trust modes shared by authoring and runtime consumers. */
export const EXTENSION_TRUST_MODES = KNOWN_EXTENSION_TRUST_MODES;

/** Canonical extension sandbox profiles shared by authoring and runtime consumers. */
export const EXTENSION_SANDBOX_PROFILES = KNOWN_EXTENSION_SANDBOX_PROFILES;

/** Restricts extension policy mode values accepted by command, SDK, and storage contracts. */
export type ExtensionPolicyMode = (typeof EXTENSION_POLICY_MODES)[number];

/** Restricts extension policy surface values accepted by command, SDK, and storage contracts. */
export type ExtensionPolicySurface = (typeof EXTENSION_POLICY_SURFACES)[number];

/** Restricts extension trust mode values accepted by command, SDK, and storage contracts. */
export type ExtensionTrustMode = (typeof EXTENSION_TRUST_MODES)[number];

/** Restricts extension sandbox profile values accepted by command, SDK, and storage contracts. */
export type ExtensionSandboxProfile =
  (typeof EXTENSION_SANDBOX_PROFILES)[number];

/** Versioned capability contract metadata emitted by runtime diagnostics. */
export {
  EXTENSION_CAPABILITY_CONTRACT,
  EXTENSION_CAPABILITY_CONTRACT_VERSION,
  EXTENSION_CAPABILITY_LEGACY_ALIASES,
};
