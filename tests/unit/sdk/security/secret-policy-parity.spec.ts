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
      expect.objectContaining({ mutationRule: "credential_key_assignment", mutationOnlyReason: expect.stringMatching(/source/) }),
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

describe("credential-key assignments (GH-1704)", () => {
  // Built at runtime: a random-looking 17-character value with no token format.
  const value = ["Zq8vN3k", "LmP0wXy7Ab"].join("");
  const rulesFor = (content: string) => scanMutationSecrets({ description: content }).map(({ rule }) => rule);
  const keys = [
    "secret", "secret_key", "client_secret", "token", "access_token", "auth_token", "GITHUB_TOKEN",
    "NPM_TOKEN", "api_key", "apikey", "api-key", "private_key", "AWS_SECRET_ACCESS_KEY",
    "db_password", "DB_PASSWORD", "passwd", "pwd",
  ];

  it.each(keys.flatMap((key) => [
    [key, `${key}: ${value}`],
    [key, `${key}=${value}`],
    [key, `{"${key}":"${value}"}`],
  ]))("flags a credential under %s: %s", (_key, content) => {
    expect(rulesFor(content)).toEqual(["credential_key_assignment"]);
  });

  it("flags element content and blocks through the CLI guard", () => {
    expect(rulesFor(`<client_secret>${value}</client_secret>`)).toEqual(["credential_key_assignment"]);
    expect(() => evaluateMutationGuard({
      author: "agent", payload: { description: `api_key=${value}` },
      settings: { require_attributed_author: false, secret_guard: "block", stale_in_progress_hours: 72 },
    })).toThrow(/Mutation blocked by secret guard/);
  });

  it("flags option and hyphenated key spellings", () => {
    expect(rulesFor(`--token=${value}`)).toEqual(["credential_key_assignment"]);
    expect(rulesFor(`reset-token: ${value}`)).toEqual(["credential_key_assignment"]);
  });

  it("scans a long hyphenated identifier in linear time", () => {
    const rule = SECRET_RULES.find((entry) => entry.mutationRule === "credential_key_assignment")!;
    const started = performance.now();
    for (const input of ["a-".repeat(16_000) + "z", "token-".repeat(8_000), "secret_".repeat(8_000)]) {
      expect([...findSecretRuleMatches(rule, input)]).toEqual([]);
    }
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("keeps password keys with the password rule, so one value is reported once", () => {
    expect(rulesFor(`password: ${value}`)).toEqual(["password_assignment"]);
    expect(rulesFor(`reset-password: ${value}`)).toEqual(["password_assignment"]);
  });

  it.each([
    ["pm token budget", "token_budget: 800"],
    ["model token ceiling", "max_tokens: 4096"],
    ["compound budget key", "output_token_budget: 3000"],
    ["numeric count", "token_count: 12"],
    ["short value", "tokens=3"],
    ["environment placeholder", "api_key: ${API_KEY}"],
    ["angle placeholder", "token: <your token>"],
    ["scrubbed placeholder", "secret: [scrubbed]"],
    ["prose", "the token expires after 5 minutes"],
    ["localization label", '"Secret question": "Pick one"'],
    ["mask", "token: ********"],
    ["repeated placeholder", "secret: xxxxxxxxxxxx"],
    ["dictionary word", "token: required"],
    ["member path", "const token = process.env.GITHUB_TOKEN;"],
    ["call expression", "token = getToken(options)"],
    ["shell variable", "token: $GITHUB_TOKEN"],
    ["Windows variable", "api_key: %API_KEY%"],
    ["working directory", "pwd=/usr/local/bin"],
    ["relative path", "token: ./build/output"],
    ["quoted prose", 'client_secret: "Configure this in the settings page"'],
    ["quoted JSON prose", '{"token":"authentication failed"}'],
    ["unquoted prose", "client_secret: Configure this"],
    ["masked element", "<token>********</token>"],
    ["scrubbed element", "<secret>[scrubbed]</secret>"],
  ])("keeps %s clean", (_label, content) => {
    expect(rulesFor(content)).not.toContain("credential_key_assignment");
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
    ["escaped quote early in a JSON value", ['{"pass', 'word":"ab\\"', value, '"}'].join("")],
    ["escaped quote in a nested array value", ['{"pass', 'word": ["ab\\"', value, '"]}'].join("")],
    ["escaped quote under an unquoted key", ['pass', 'word: "ab\\"', value, '"'].join("")],
    ["prefixed key with a compact value", `{"admin-password": "${value}"}`],
    ["prefixed key with a compact nested value", `smtp.password: ["${value}"]`],
    ["exact key with a passphrase", ['{"pass', 'word": "correct horse ', value, '"}'].join("")],
    ["exact nested key with a passphrase under a prefixed key", ['{"admin-pass', 'word":{"pass', 'word":["correct horse ', value, '"]}}'].join("")],
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
    ["short value made only of escapes", ['"pass', 'word": "\\"\\""'].join("")],
    ["escaped line breaks counted once each", ['{"pass', 'word":"\\n\\n\\n\\n"}'].join("")],
    ["unicode escapes counted once each", ['{"pass', 'word":"\\u0061\\u0062"}'].join("")],
    ["prefixed localization key with a prose value", '{"reset-password":"Reset password"}'],
    ["prefixed localization key with an escaped space", ['{"reset-pass', 'word":"Reset\\u0020password"}'].join("")],
    ["escaped backslash closing a short value", ['{"pass', 'word":"abc\\\\"}'].join("")],
    ["spaced localization key with a prose value", '{"New password": "Enter a new password"}'],
    ["underscore-prefixed key, as in the flat rule", '{"db_password": "S3cr3tValue!"}'],
    ["closing key quote with no opening quote", [`${"label ".repeat(11)}pass`, 'word": ', value].join("")],
    ["closing key quote after a line break", ["[\n  pass", 'word": "', value, '"]'].join("")],
    ["escaped literal that spans a raw line break", ['{"pass', 'word": "ab\\"c\n', value, '"}'].join("")],
    ["unterminated escaped literal", ['{"pass', 'word": "ab\\"', value].join("")],
    ["JSON Schema description under an exact key", '{"password": {"type": "string", "description": "The account password"}}'],
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

  it("judges a fully unicode-escaped high-entropy value in its decoded form", () => {
    const escaped = [...entropy].map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
    expect(scanMutationSecrets({ description: `{"token":"${escaped}"}` }).map(({ rule }) => rule)).toContain("high_entropy_assignment");
  });

  it("decodes eight-digit unicode escapes before judging a value", () => {
    const escaped = [...entropy].map((character) => `\\U${character.charCodeAt(0).toString(16).padStart(8, "0")}`).join("");
    expect(scanMutationSecrets({ description: `{"token":"${escaped}"}` }).map(({ rule }) => rule)).toContain("high_entropy_assignment");
    expect(scanMutationSecrets({ description: ['{"pass', 'word":"\\U00000061\\U00000062"}'].join("") })).toEqual([]);
    expect(scanMutationSecrets({ description: ['{"pass', 'word":"\\Uffffffff"}'].join("") })).toEqual([]);
  });

  it("decodes Python octal escapes before judging a value", () => {
    const octal = [...entropy].map((character) => `\\${character.charCodeAt(0).toString(8).padStart(3, "0")}`).join("");
    expect(scanMutationSecrets({ description: `{'token':'${octal}'}` }).map(({ rule }) => rule)).toContain("high_entropy_assignment");
    expect(scanMutationSecrets({ description: ['{"pass', 'word":"\\101\\102\\103"}'].join("") })).toEqual([]);
  });

  it("counts a single-quoted literal under both its TOML/YAML and its Python reading", () => {
    expect(scanMutationSecrets({ description: ['"pass', "word\" = '\\101\\102\\103'"].join("") }).map(({ rule }) => rule)).toContain("password_assignment");
    expect(scanMutationSecrets({ description: ["{'pass", "word':'ab\\'", "cdefghijk'}"].join("") }).map(({ rule }) => rule)).toContain("password_assignment");
  });

  it("applies the compact-key check to each reading of a single-quoted literal", () => {
    expect(scanMutationSecrets({ description: ['"admin-pass', "word\": 'A9b\\nC2dE'"].join("") }).map(({ rule }) => rule)).toContain("password_assignment");
  });

  it("decodes an incomplete escape as its letter, not as NUL", () => {
    const token = `${entropy.slice(0, 12)}\\x${entropy.slice(12)}`;
    expect(scanMutationSecrets({ description: `{"token":"${token}"}` }).map(({ rule }) => rule)).toContain("high_entropy_assignment");
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
      "password=".repeat(80_000),
    ];
    const started = performance.now();
    const counts = inputs.map((input) => Array.from(findSecretRuleMatches(rule, input)).length);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(counts).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 2, 1]);
  });
});
