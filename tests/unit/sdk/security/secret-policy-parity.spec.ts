import { describe, expect, it } from "vitest";
import { scanMutationSecrets, evaluateMutationGuard } from "../../../../src/sdk/mutation-guard.js";
import { createScriptHarness } from "../../../helpers/scriptModule.js";

import { SECRET_RULES, findSecretRuleMatches } from "../../../../src/core/shared/secret-rules.js";

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
  it.each([
    ["empty fallback", "config.auth.password || ''", false],
    ["terminated empty fallback", 'config.auth.password || ""; ', false],
    ["line-commented empty fallback", 'config.auth.password || "" // explanation', false],
    ["CRLF-terminated line comment", 'config.auth.password || "" // explanation\r\n', false],
    ["block-commented empty fallback", "config.auth.password || '' /* explanation */", false],
    ["commented optional configuration", "config.auth.password ? unescape(encodeURIComponent(config.auth.password)) : '' /* explanation */;", false],
    ["multiple trailing block comments", "config.auth.password || '' /* first */ /* second */;", false],
    ["encoded optional configuration", "config.auth.password ? unescape(encodeURIComponent(config.auth.password)) : ''", false],
    ["terminated optional configuration", 'config.auth.password ? unescape(encodeURIComponent(config.auth.password)) : "";', false],
    ["chained fallback", 'config.auth.password || "" || "example-value"', true],
    ["concatenated fallback", "config.auth.password || '' + 'example-value'", true],
    ["composed optional configuration", "config.auth.password ? unescape(encodeURIComponent(config.auth.password)) : '' + 'example-value'", true],
    ["continued fallback", "config.auth.password || ''\n || 'example-value'", true],
    ["continued line-commented fallback", "config.auth.password || '' // explanation\n || 'example-value'", true],
    ["Unicode line-separated fallback", "config.auth.password || '' // explanation\u2028 || 'example-value'", true],
    ["Unicode paragraph-separated fallback", "config.auth.password || '' // explanation\u2029 || 'example-value'", true],
    ["continued block-commented fallback", "config.auth.password || '' /* explanation */ + 'example-value'", true],
    ["credential between block comments", "config.auth.password || '' /* first */ + 'example-value' /* second */", true],
    ["comma expression", "config.auth.password || '', 'example-value'", true],
    ["bare credential-shaped value", "config.auth.password", true],
    ["nonempty fallback", "config.auth.password || 'example-value'", true],
    ["quoted expression", '"config.auth.password || empty"', true],
  ] as const)("distinguishes %s from a literal password in both consumers", async (_label, expression, detected) => {
    const gate = await harness.importModule<{
      scanContent(file: string, content: string): Array<{ rule: string }>;
    }>("scripts/check-secrets-lib.mjs");
    const content = ["password", "=", expression].join(" ");
    expect(gate.scanContent("patches/dependency.patch", content).some(({ rule }) => rule === "password-assignment")).toBe(detected);
    expect(scanMutationSecrets({ description: content }).some(({ rule }) => rule === "password_assignment")).toBe(detected);
  });

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

describe("structured credential spellings (GH-1699)", () => {
  // Built at runtime so this file stays clean under the repository scan it exercises.
  const value = ["Synthetic", "Only123!"].join("");
  const entropy = ["aB3dE5fG7hJ9k", "L1mN3pQ5rS7tU9vW"].join("");
  const gateHarness = createScriptHarness();
  const scanBoth = async (content: string, gateRule: string, mutationRule: string) => {
    const gate = await gateHarness.importModule<{
      scanContent(file: string, content: string): Array<{ rule: string }>;
    }>("scripts/check-secrets-lib.mjs");
    return {
      gate: gate.scanContent("patches/dependency.patch", content).some(({ rule }) => rule === gateRule),
      mutation: scanMutationSecrets({ description: content }).some(({ rule }) => rule === mutationRule),
    };
  };

  it.each([
    ["JSON key", `{"password":"${value}"}`],
    ["spaced JSON key", `"password": "${value}"`],
    ["single-quoted key", `'password':'${value}'`],
    ["passphrase key", `{"passphrase": "${value}"}`],
    ["quoted key with an unquoted YAML value", `'password': ${value}`],
    ["TOML quoted key", `"password" = "${value}"`],
    ["multi-line JSON", `{\n  "password":\n    "${value}"\n}`],
    ["nested array", `Config: {"password":["${value}"]}`],
    ["nested object", `Config: {"password":{"value":"${value}"}}`],
    ["later nested value", `{"password": ["", {"note": [true, 7]}, "${value}"]}`],
    ["value after an escaped quote", ['{"pass', 'word": ["a\\"b", "', value, '"]}'].join("")],
    ["unquoted key with an array", `password: ["${value}"]`],
    ["bare nested key", `{"password": {value: "${value}"}}`],
    ["nested quoted key with a bare YAML value", `password: {x: 'short', 'password': ${value}}`],
    ["nested quoted JSON key with a bare value", `{"password": {"note": "short", "password": ${value}}}`],
    ["XML element", `<password>${value}</password>`],
    ["XML element with attributes", `<password type="text">${value}</password>`],
    ["multi-line XML element", ["<pass", "phrase>\n  ", value, "\n</passphrase>"].join("")],
  ])("refuses the %s spelling in both consumers", async (_label, content) => {
    expect(await scanBoth(content, "password-assignment", "password_assignment")).toEqual({ gate: true, mutation: true });
  });

  it.each([
    ["empty value", '"password": ""'],
    ["environment placeholder", '"password": "${BUILD_PASSWORD}"'],
    ["command placeholder", '"password": "$(op read pw)"'],
    ["angle placeholder", '"password": "<your-password>"'],
    ["suffixed key", '"password_policy": "rotate monthly"'],
    ["prose", "the password field"],
    ["bare container token", "password=[scrubbed]"],
    ["nested keys only", '{"password": {"type": "str"}}'],
    ["short nested value", '{"password": ["short"]}'],
    ["string literal that spans a line break", ["{ input: '{\"password\": ', safe: true },", "  { id: 'next' }"].join("\n")],
    ["empty element", "<password></password>"],
    ["placeholder element", "<password>${X}</password>"],
    ["command element", "<password>$(cat pw)</password>"],
    ["short element", "<password>short</password>"],
    ["unterminated container", '{"password": ["short"'],
    ["mismatched container", '{"password": ["short"}'],
    ["value after the container closes", `{"password": ["short"]} "${value}"`],
    ["key at the end of input", '{"password": '],
  ])("allows the %s in both consumers", async (_label, content) => {
    expect(await scanBoth(content, "password-assignment", "password_assignment")).toEqual({ gate: false, mutation: false });
  });

  it.each([
    ["quoted key", `{"token": "${entropy}"}`],
    ["nested array", `{'api_key': ['${entropy}']}`],
    ["nested object", `{"secret": {"value": "${entropy}"}}`],
  ])("detects a high-entropy %s in mutation payloads only", (_label, content) => {
    expect(scanMutationSecrets({ description: content }).map(({ rule }) => rule)).toContain("high_entropy_assignment");
  });

  it("keeps the entropy predicate for structured high-entropy values", () => {
    expect(scanMutationSecrets({ description: `{"token": "${"a".repeat(28)}"}` })).toEqual([]);
  });

  it("returns the same verdict through the blocking guard the CLI uses", () => {
    expect(() => evaluateMutationGuard({
      author: "agent", payload: { description: `{"password":["${value}"]}` },
      settings: { require_attributed_author: false, secret_guard: "block", stale_in_progress_hours: 72 },
    })).toThrow(/Mutation blocked by secret guard \(password_assignment\)/);
  });

  it("keeps interleaved scans of one rule independent", () => {
    const rule = SECRET_RULES.find(({ mutationRule }) => mutationRule === "password_assignment")!;
    const first = findSecretRuleMatches(rule, `{"password":"${value}"} {"password":"${value}"}`);
    const second = findSecretRuleMatches(rule, `{"password":"${value}"}`);
    expect(first.next().done).toBe(false);
    expect([...second]).toHaveLength(1);
    expect([...first]).toHaveLength(1);
  });

  it("finishes pathological structured inputs in linear time", () => {
    const rule = SECRET_RULES.find(({ mutationRule }) => mutationRule === "password_assignment")!;
    const inputs = [
      `{"password": ${"[".repeat(200_000)}`,
      `"password": ["${"a".repeat(400_000)}`,
      `password: [${'"a", '.repeat(80_000)}]`,
      '{"password": '.repeat(40_000),
      '"password":"'.repeat(40_000),
      `<password>${"x".repeat(400_000)}`,
      `<password ${"a".repeat(400_000)}`,
      "<password ".repeat(40_000),
      `${'{"password": '.repeat(20_000)}"${"a".repeat(400_000)}"`,
    ];
    const started = performance.now();
    const counts = inputs.map((input) => Array.from(findSecretRuleMatches(rule, input)).length);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(counts).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 2]);
  });
});
