import { describe, expect, it } from "vitest";
import { scanMutationSecrets, evaluateMutationGuard } from "../../../../src/sdk/mutation-guard.js";
import { createScriptHarness } from "../../../helpers/scriptModule.js";

import { SECRET_RULES } from "../../../../src/core/shared/secret-rules.js";

const harness = createScriptHarness();
const samples = [
  ["private_key", ["-----BEGIN PKCS8 ", "PRIVATE KEY-----"].join("")],
  ["github_token", `ghp_${"a".repeat(24)}`],
  ["npm_token", `npm_${"a".repeat(24)}`],
  ["aws_access_key", `ASIA${"A".repeat(16)}`],
  ["slack_token", `xoxb-${"a".repeat(24)}`],
  ["google_api_key", `AIza${"a".repeat(35)}`],
  ["anthropic_api_key", `sk-ant-${"a".repeat(24)}`],
  ["openai_api_key", `sk-proj-${"a".repeat(24)}`],
  ["gitlab_token", `glpat-${"a".repeat(24)}`],
  ["jwt_like_token", `eyJ${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(12)}`],
  ["npm_auth_token_assignment", ["_auth", "Token=", "example"].join("")],
  ["sentry_user_token", `sntryu_${"a".repeat(24)}`],
  ["sentry_org_token", `sntrys_${"a".repeat(24)}`],
  ["private_ip", ["192", "168", "42", "19"].join(".")],
  ["private_ssh_target", `ssh user@${["10", "42", "0", "1"].join(".")}`],
  ["sshpass_inline_password", ["sshpass", "-p", '"example-value"'].join(" ")],
  ["password_assignment", ["password", "=", "example-value"].join("")],
  ["absolute_home_path", ["/home", "example", "project", "file"].join("/")],
  ["user_at_private_host", `user@${["172", "16", "0", "1"].join(".")}`],
] as const;

describe("shared mutation and repository secret policy", () => {
  it("accounts for every detector and explicitly declares scope exceptions", async () => {
    const gate = await harness.importModule<{ RULES: Array<{ name: string; regex: RegExp }> }>("scripts/check-secrets-lib.mjs");
    const shared = SECRET_RULES.filter((rule) => !("mutationOnlyReason" in rule));
    expect(gate.RULES.map((rule) => [rule.name, rule.regex.source, rule.regex.flags]))
      .toEqual(shared.map((rule) => [rule.name, rule.regex.source, rule.regex.flags]));
    expect(new Set(samples.map(([rule]) => rule))).toEqual(new Set(shared.map((rule) => rule.mutationRule)));
    expect(SECRET_RULES.filter((rule) => "mutationOnlyReason" in rule)).toEqual([
      expect.objectContaining({ mutationRule: "high_entropy_assignment", mutationOnlyReason: expect.stringMatching(/source/) }),
    ]);
  });

  it.each(samples)("detects and redacts %s in both consumers", async (rule, value) => {
    const gate = await harness.importModule<{
      scanContent(file: string, content: string): Array<{rule: string}>;
    }>("scripts/check-secrets-lib.mjs");
    const gateRules = gate.scanContent(".agents/pm/history/fixture.jsonl", value)
      .map((finding) => finding.rule.replaceAll("-", "_"));
    const findings = scanMutationSecrets({ description: value });
    expect(gateRules).toContain(rule);
    expect(findings.map((finding) => finding.rule)).toEqual(gateRules);
    expect(JSON.stringify(findings)).not.toContain(value);
    expect(() => evaluateMutationGuard({
      author: "agent", payload: {description: value},
      settings: {require_attributed_author: false, secret_guard: "block", stale_in_progress_hours: 72},
    })).toThrow(/Mutation blocked by secret guard/);
  });
});
