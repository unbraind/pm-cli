/** @module tests/types/secret-guard-policy.test-d Typed secret-guard policies survive new detectors (pm-gh1749). */
import {
  SECRET_GUARD_RULE_CATEGORIES,
  decideSecretGuardFinding,
  scanMutationSecrets,
  secretGuardRuleCategory,
  type SecretGuardFinding,
  type SecretGuardPolicy,
  type SecretGuardRule,
  type SecretGuardRuleCategory,
} from "@unbrained/pm-cli/sdk";
import type { SecretGuardPolicy as GovernancePolicy } from "@unbrained/pm-cli/sdk/governance";

// A policy that names only categories compiles whatever the rule union holds.
const byCategory: SecretGuardPolicy<boolean> = { default: true, categories: { network: false, path: false } };
const governancePolicy: GovernancePolicy<boolean> = byCategory;
void governancePolicy;

// The category set is the exhaustive, stable key a consumer can map.
const everyCategory: Record<SecretGuardRuleCategory, boolean> = { credential: true, network: false, path: false };
void everyCategory;

// @ts-expect-error a category outside the stable set is rejected
const unknownCategory: SecretGuardPolicy<boolean> = { default: true, categories: { identity: false } };
void unknownCategory;

// @ts-expect-error a rule entry must name a shipped detector
const unknownRule: SecretGuardPolicy<boolean> = { default: true, rules: { future_token: false } };
void unknownRule;

// @ts-expect-error the default decision is required
const noDefault: SecretGuardPolicy<boolean> = { categories: { network: false } };
void noDefault;

// @ts-expect-error the default can never be undefined, even when the decision type allows it
const undefinedDefault: SecretGuardPolicy<boolean | undefined> = { default: undefined };
void undefinedDefault;
const optionalDecisions: SecretGuardPolicy<boolean | undefined> = { default: true, rules: { private_ip: undefined } };
void optionalDecisions;
// @ts-expect-error an unknown decision type still needs a defined default
const unknownUndefinedDefault: SecretGuardPolicy<unknown> = { default: undefined };
void unknownUndefinedDefault;
const nullDefault: SecretGuardPolicy<string | null> = { default: null };
void nullDefault;

const withRules: SecretGuardPolicy<"refuse" | "allow"> = {
  default: "refuse",
  categories: { network: "allow" },
  rules: { private_ssh_target: "refuse", credential_key_assignment: "refuse" },
};

declare const finding: SecretGuardFinding;
const decision: "refuse" | "allow" = decideSecretGuardFinding(withRules, finding);
void decision;
// An unannotated default-only policy infers its decision type from the default.
const inferredBoolean: boolean = decideSecretGuardFinding({ default: true }, finding);
const inferredString: string = decideSecretGuardFinding({ default: "refuse" }, finding);
// @ts-expect-error the inferred decision type is not widened to unknown
const inferredNotUnknown: number = decideSecretGuardFinding({ default: true }, finding);
void inferredBoolean;
void inferredString;
void inferredNotUnknown;
// A finding decoded from JSON carries only a string rule.
const decoded: boolean = decideSecretGuardFinding(byCategory, { rule: "rule-from-a-newer-host" });
void decoded;
// @ts-expect-error the decision type follows the policy
const wrongDecision: number = decideSecretGuardFinding(byCategory, finding);
void wrongDecision;

const rule: SecretGuardRule = scanMutationSecrets({})[0]!.rule;
const category: SecretGuardRuleCategory = SECRET_GUARD_RULE_CATEGORIES[rule];
const maybeCategory: SecretGuardRuleCategory | undefined = secretGuardRuleCategory("anything");
// @ts-expect-error an unknown rule may have no category
const definiteCategory: SecretGuardRuleCategory = secretGuardRuleCategory("anything");
void category;
void maybeCategory;
void definiteCategory;
