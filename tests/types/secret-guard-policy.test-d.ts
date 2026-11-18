/** @module tests/types/secret-guard-policy.test-d Typed secret-guard policies survive new detectors (pm-gh1749). */
import {
  SECRET_GUARD_RULE_CATEGORIES,
  decideSecretGuardFinding,
  scanMutationSecrets,
  secretGuardRuleCategory,
  type SecretGuardFinding,
  type SecretGuardPolicy,
  type SecretGuardPolicyDecision,
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

// A rule this SDK does not ship yet may already be decided, for a newer host.
const forwardRule: SecretGuardPolicy<boolean> = { default: true, rules: { future_token: false } };
void forwardRule;
// Every rule entry is a decision, even one assigned through a variable.
const mixedRules = { private_ip: false, future_token: "refuse" };
// @ts-expect-error an entry that is not a decision is rejected
const mixedPolicy: SecretGuardPolicy<boolean> = { default: true, rules: mixedRules };
void mixedPolicy;

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
// null stays a valid default even when the decision type is unknown.
const unknownNullDefault: SecretGuardPolicy<unknown> = { default: null };
void unknownNullDefault;

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
// A policy checked with `satisfies` keeps its literal types; the helper still
// infers the union of the default and every override decision.
const satisfied = { default: "refuse", categories: { network: "allow" } } satisfies SecretGuardPolicy<"refuse" | "allow">;
const fromSatisfied: "refuse" | "allow" = decideSecretGuardFinding(satisfied, finding);
void fromSatisfied;
// An inline policy with overrides infers the same union, null included.
const inlineMixed: boolean = decideSecretGuardFinding({ default: true, categories: { network: false } }, finding);
const inlineNullable: string | null = decideSecretGuardFinding({ default: "refuse", rules: { private_ip: null } }, finding);
// @ts-expect-error the null override stays in the inferred union
const inlineNotNull: string = decideSecretGuardFinding({ default: "refuse", rules: { private_ip: null } }, finding);
void inlineMixed;
void inlineNullable;
void inlineNotNull;
// @ts-expect-error an inferred union is not narrowed to the default alone
const onlyDefault: "refuse" = decideSecretGuardFinding(satisfied, finding);
void onlyDefault;
// Decisions of different kinds are kept together, inline or with `satisfies`.
const mixedKinds = { default: true, categories: { network: "allow" } } satisfies SecretGuardPolicy<true | "allow">;
const fromMixedKinds: true | "allow" = decideSecretGuardFinding(mixedKinds, finding);
const inlineMixedKinds: boolean | string = decideSecretGuardFinding({ default: true, rules: { private_ip: "allow" } }, finding);
// @ts-expect-error the string override stays in the inferred union
const mixedNotBoolean: boolean = decideSecretGuardFinding({ default: true, rules: { private_ip: "allow" } }, finding);
void fromMixedKinds;
void inlineMixedKinds;
void mixedNotBoolean;
// An annotated policy returns its decision type without the `undefined` of an absent entry.
const fromOptional: boolean = decideSecretGuardFinding(optionalDecisions, finding);
const unknownDecision: unknown = decideSecretGuardFinding({} as SecretGuardPolicy<unknown>, finding);
const derived: true | "allow" = {} as SecretGuardPolicyDecision<typeof mixedKinds>;
void fromOptional;
void unknownDecision;
void derived;
// A union of policy types keeps an override that only one member declares.
declare const eitherPolicy: { default: boolean } | { default: boolean; categories: { network: "review" } };
const fromEither: boolean | "review" = decideSecretGuardFinding(eitherPolicy, finding);
// @ts-expect-error the override of one union member is not dropped
const eitherNotBoolean: boolean = decideSecretGuardFinding(eitherPolicy, finding);
void fromEither;
void eitherNotBoolean;
// A generic wrapper keeps the defined result type of its SecretGuardPolicy<D>.
function decideWith<D>(policy: SecretGuardPolicy<D>): Exclude<D, undefined> {
  return decideSecretGuardFinding(policy, finding);
}
const wrapped: boolean = decideWith<boolean | undefined>({ default: true });
void wrapped;
// A wrapper generic over the policy type passes it explicitly and keeps every decision.
function decideAny<P extends SecretGuardPolicy<unknown>>(policy: P): SecretGuardPolicyDecision<P> {
  return decideSecretGuardFinding<P>(policy, finding);
}
const wrappedMixed: true | "allow" = decideAny(mixedKinds);
void wrappedMixed;
// A categories index signature that covers a category counts, as the helper reads it.
declare const templated: { default: true; categories: { [key: `net${string}`]: "allow" } & { path: "review" } };
const fromTemplated: true | "allow" | "review" = decideSecretGuardFinding(templated, finding);
// @ts-expect-error the decision under the index signature is not dropped
const templatedNarrow: true | "review" = decideSecretGuardFinding(templated, finding);
void fromTemplated;
void templatedNarrow;
// A string-indexed categories map covers every category, so its decisions count.
declare const dictionary: { default: string; categories: Record<string, null> };
const fromDictionary: string | null = decideSecretGuardFinding(dictionary, finding);
// @ts-expect-error the null under the string index is not dropped
const dictionaryNotNull: string = decideSecretGuardFinding(dictionary, finding);
void fromDictionary;
void dictionaryNotNull;
// A categories key that names no stable category is ignored, in the result type too.
const ignoredCategory: boolean = decideSecretGuardFinding({ default: true, categories: { network: false, identity: 3 } }, finding);
void ignoredCategory;
// The call site still validates the policy shape.
// @ts-expect-error the default decision is required at the call site
decideSecretGuardFinding({ categories: { network: false } }, finding);
// @ts-expect-error an undefined default is rejected at the call site
decideSecretGuardFinding({ default: undefined }, finding);
// @ts-expect-error a categories map naming no stable category is rejected at the call site
decideSecretGuardFinding({ default: true, categories: { identity: false } }, finding);
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
