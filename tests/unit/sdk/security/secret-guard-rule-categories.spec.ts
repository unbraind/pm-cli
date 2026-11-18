import { afterEach, describe, expect, it, vi } from "vitest";
import { SECRET_RULES, type SecretRule } from "../../../../src/core/shared/secret-rules.js";
import {
  SECRET_GUARD_RULE_CATEGORIES,
  decideSecretGuardFinding,
  scanMutationSecrets,
  secretGuardRuleCategory,
  type SecretGuardPolicy,
} from "../../../../src/sdk/mutation-guard.js";
import * as sdk from "../../../../src/sdk/index.js";
import * as governance from "../../../../src/sdk/governance.js";

// pm-gh1749: a stable category per detector and a default-plus-overrides
// policy, so adding a detector never breaks a typed consumer.
const EXPECTED_CATEGORIES = {
  private_key: "credential",
  github_token: "credential",
  npm_token: "credential",
  aws_access_key: "credential",
  google_api_key: "credential",
  slack_token: "credential",
  anthropic_api_key: "credential",
  openai_api_key: "credential",
  gitlab_token: "credential",
  jwt_like_token: "credential",
  npm_auth_token_assignment: "credential",
  sentry_user_token: "credential",
  sentry_org_token: "credential",
  private_ip: "network",
  private_ssh_target: "network",
  sshpass_inline_password: "credential",
  password_assignment: "credential",
  absolute_home_path: "path",
  user_at_private_host: "network",
  high_entropy_assignment: "credential",
  credential_key_assignment: "credential",
} as const;

const PRIVATE_ADDRESS = ["192", "168", "42", "19"].join(".");
const GITHUB_SHAPED = `ghp_${"a".repeat(24)}`;

afterEach(() => {
  vi.doUnmock("../../../../src/core/shared/secret-rules.js");
  vi.resetModules();
});

describe("secret guard rule categories", () => {
  it("assigns every shipped detector exactly one pinned category", () => {
    expect(SECRET_GUARD_RULE_CATEGORIES).toEqual(EXPECTED_CATEGORIES);
    expect(Object.keys(SECRET_GUARD_RULE_CATEGORIES)).toEqual(SECRET_RULES.map((rule) => rule.mutationRule));
    expect(Object.isFrozen(SECRET_GUARD_RULE_CATEGORIES)).toBe(true);
  });

  it("answers a known rule and leaves unknown and prototype names undefined", () => {
    expect(secretGuardRuleCategory("credential_key_assignment")).toBe("credential");
    expect(secretGuardRuleCategory("private_ip")).toBe("network");
    expect(secretGuardRuleCategory("absolute_home_path")).toBe("path");
    for (const unknown of ["future_token", "", "constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(secretGuardRuleCategory(unknown)).toBeUndefined();
    }
  });

  it("is exported from the root and governance SDK entrypoints", () => {
    for (const entrypoint of [sdk, governance]) {
      expect(entrypoint.SECRET_GUARD_RULE_CATEGORIES).toBe(SECRET_GUARD_RULE_CATEGORIES);
      expect(entrypoint.decideSecretGuardFinding).toBe(decideSecretGuardFinding);
      expect(entrypoint.secretGuardRuleCategory).toBe(secretGuardRuleCategory);
    }
  });
});

describe("decideSecretGuardFinding", () => {
  const policy: SecretGuardPolicy<"refuse" | "allow" | "review"> = {
    default: "refuse",
    categories: { network: "allow", path: "review" },
    rules: { private_ssh_target: "refuse", absolute_home_path: "allow" },
  };

  it("lets a rule entry beat its category entry and a category entry beat the default", () => {
    expect(decideSecretGuardFinding(policy, { rule: "private_ssh_target" })).toBe("refuse");
    expect(decideSecretGuardFinding(policy, { rule: "private_ip" })).toBe("allow");
    expect(decideSecretGuardFinding(policy, { rule: "user_at_private_host" })).toBe("allow");
    expect(decideSecretGuardFinding(policy, { rule: "absolute_home_path" })).toBe("allow");
    expect(decideSecretGuardFinding(policy, { rule: "github_token" })).toBe("refuse");
  });

  it("gives every shipped detector its category decision when no rule entry names it", () => {
    const byCategory: SecretGuardPolicy<string> = { default: "default", categories: { credential: "credential", network: "network", path: "path" } };
    for (const rule of SECRET_RULES) {
      expect(decideSecretGuardFinding(byCategory, { rule: rule.mutationRule })).toBe(rule.category);
    }
  });

  it("decides a rule this SDK does not know, and prototype names, by the default", () => {
    for (const rule of ["future_token", "constructor", "__proto__", "toString"]) {
      expect(decideSecretGuardFinding({ default: false, categories: { credential: true }, rules: {} }, { rule })).toBe(false);
    }
  });

  it("treats an undefined entry as absent but honours null and false decisions", () => {
    expect(decideSecretGuardFinding({ default: "default", categories: { network: "network" }, rules: { private_ip: undefined } }, { rule: "private_ip" })).toBe("network");
    expect(decideSecretGuardFinding({ default: "default", categories: { network: undefined } }, { rule: "private_ip" })).toBe("default");
    expect(decideSecretGuardFinding<string | null>({ default: "default", rules: { private_ip: null } }, { rule: "private_ip" })).toBeNull();
    expect(decideSecretGuardFinding<string | null>({ default: "default", categories: { network: null } }, { rule: "private_ip" })).toBeNull();
    expect(decideSecretGuardFinding({ default: true, categories: { network: false } }, { rule: "private_ip" })).toBe(false);
    expect(decideSecretGuardFinding({ default: false }, { rule: "github_token" })).toBe(false);
  });

  it("ignores inherited entries and keys that name no rule or category", () => {
    const inherited = Object.create({ private_ip: "inherited" }) as Partial<Record<"private_ip", string>>;
    const categories = Object.create({ network: "inherited" }) as Partial<Record<"network", string>>;
    expect(decideSecretGuardFinding({ default: "default", rules: inherited, categories }, { rule: "private_ip" })).toBe("default");
    const forward = { default: "default", rules: { future_token: "future" }, categories: { identity: "identity" } } as unknown as SecretGuardPolicy<string>;
    expect(decideSecretGuardFinding(forward, { rule: "private_ip" })).toBe("default");
    expect(decideSecretGuardFinding(forward, { rule: "future_token" })).toBe("future");
  });

  it("reads the finding's rule and the policy's default once", () => {
    let ruleReads = 0;
    const finding = { get rule() { ruleReads += 1; if (ruleReads > 1) throw new Error("rule read twice"); return "private_ip"; } };
    expect(decideSecretGuardFinding({ default: "default", categories: { network: "network" } }, finding)).toBe("network");
    let defaultReads = 0;
    const policy = { get default() { defaultReads += 1; return defaultReads > 1 ? undefined : "own"; } } as unknown as SecretGuardPolicy<string>;
    expect(decideSecretGuardFinding(policy, { rule: "private_ip" })).toBe("own");
    expect(defaultReads).toBe(1);
  });

  it("reads only the policy's own default, categories and rules", () => {
    const inheritedDefault = Object.create({ default: "inherited" }) as SecretGuardPolicy<string>;
    expect(() => decideSecretGuardFinding(inheritedDefault, { rule: "private_ip" })).toThrow(new TypeError("Secret guard policy requires a default decision."));
    const inheritedMaps = Object.assign(Object.create({ categories: { network: "inherited" }, rules: { private_ip: "inherited" } }), { default: "own" }) as SecretGuardPolicy<string>;
    expect(decideSecretGuardFinding(inheritedMaps, { rule: "private_ip" })).toBe("own");
    const inheritedInvalid = Object.assign(Object.create({ categories: "not-an-object" }), { default: "own" }) as SecretGuardPolicy<string>;
    expect(decideSecretGuardFinding(inheritedInvalid, { rule: "private_ip" })).toBe("own");
  });

  it("decides real scanner findings", () => {
    const findings = scanMutationSecrets({ host: PRIVATE_ADDRESS, token: GITHUB_SHAPED });
    expect(findings.map((finding) => [finding.rule, decideSecretGuardFinding({ default: "refuse", categories: { network: "allow" } }, finding)])).toEqual(
      expect.arrayContaining([["private_ip", "allow"], ["github_token", "refuse"]]),
    );
    expect(findings.length).toBeGreaterThanOrEqual(2);
  });

  it.each([
    ["a null policy", null, { rule: "private_ip" }, "Secret guard policy must be an object with a default decision."],
    ["an array policy", [], { rule: "private_ip" }, "Secret guard policy must be an object with a default decision."],
    ["a string policy", "refuse", { rule: "private_ip" }, "Secret guard policy must be an object with a default decision."],
    ["a policy without a default", { categories: {} }, { rule: "private_ip" }, "Secret guard policy requires a default decision."],
    ["an undefined default", { default: undefined }, { rule: "private_ip" }, "Secret guard policy requires a default decision."],
    ["null categories", { default: true, categories: null }, { rule: "private_ip" }, "Secret guard policy categories must be an object keyed by category."],
    ["array categories", { default: true, categories: [] }, { rule: "private_ip" }, "Secret guard policy categories must be an object keyed by category."],
    ["string rules", { default: true, rules: "private_ip" }, { rule: "private_ip" }, "Secret guard policy rules must be an object keyed by rule."],
    ["a null finding", { default: true }, null, "Secret guard finding must have a string rule."],
    ["a string finding", { default: true }, "private_ip", "Secret guard finding must have a string rule."],
    ["a finding without a rule", { default: true }, {}, "Secret guard finding must have a string rule."],
    ["a numeric rule", { default: true }, { rule: 7 }, "Secret guard finding must have a string rule."],
  ])("refuses %s", (_label, input, finding, message) => {
    expect(() => decideSecretGuardFinding(input as SecretGuardPolicy<boolean>, finding as { rule: string })).toThrow(new TypeError(message));
  });
});

describe("a detector added after a consumer wrote its policy", () => {
  it("inherits its category decision without any policy change", async () => {
    // Drop the guard the static import loaded, so the mocked inventory applies
    // even when this test runs alone.
    vi.resetModules();
    const futureRule: SecretRule = { name: "future-token", mutationRule: "future_token", category: "credential", regex: /\bfuture_[a-z]{12}\b/g };
    vi.doMock("../../../../src/core/shared/secret-rules.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../../../../src/core/shared/secret-rules.js")>();
      return { ...original, SECRET_RULES: [...original.SECRET_RULES, futureRule] };
    });
    const guard = await import("../../../../src/sdk/mutation-guard.js");
    const written: SecretGuardPolicy<boolean> = { default: false, categories: { credential: true }, rules: { private_ip: false } };
    const [finding] = guard.scanMutationSecrets({ note: `future_${"q".repeat(12)}` });
    expect(finding).toMatchObject({ rule: "future_token" });
    expect(guard.secretGuardRuleCategory("future_token")).toBe("credential");
    expect(guard.decideSecretGuardFinding(written, finding!)).toBe(true);
  });
});
