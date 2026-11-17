/**
 * Regression coverage for pm-hw00c2 (credential_key_assignment judges a
 * referenced value by the literal it spells, and one `$NAME` policy holds for
 * every key-named rule), pm-bn3ppf (a key inside a rejected reference value
 * is still judged) and pm-x07qz2 (payload property names are scanned, and a
 * flagged name never appears in a finding path).
 */
import { describe, expect, it } from "vitest";
import { evaluateMutationGuard, scanMutationSecrets } from "../../../../src/sdk/mutation-guard.js";
import { SECRET_RULES, expandRuntimeReferences, findSecretRuleMatches, literalAfterReferences, type SecretRule } from "../../../../src/core/shared/secret-rules.js";
import { createScriptHarness } from "../../../helpers/scriptModule.js";

const harness = createScriptHarness();
const gateRules = async (content: string) =>
  (await harness.importModule<{ scanContent(file: string, content: string): Array<{ rule: string }> }>("scripts/check-secrets-lib.mjs"))
    .scanContent("docs/runbook.md", content).map(({ rule }) => rule);

const blockSettings = { require_attributed_author: false, secret_guard: "block", stale_in_progress_hours: 72 } as const;
const ruleNamed = (mutationRule: string) => SECRET_RULES.find((rule) => rule.mutationRule === mutationRule)! as SecretRule;
const textRules = (content: string) => scanMutationSecrets({ description: content }).map(({ rule }) => rule);
const payloadRules = (payload: unknown) => scanMutationSecrets(payload).map(({ rule }) => rule);

// Built at runtime so this file stays clean under the repository scan.
const credential = ["Zq8vN3k", "LmP0wXy7Ab"].join("");
const punctuated = ["q7!A", "?9#z"].join("");
const githubToken = ["ghp_", "Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56"].join("");
const literal = ["Synthetic", "Only123"].join("");

describe("credential-key values are judged by the literal they spell (pm-hw00c2)", () => {
  it.each([
    ["literal after a braced reference", `api_key=\${EMPTY}"${credential}"`],
    ["literal after a CONSTANT_CASE variable", `api_key=$VAR"${credential}"`],
    ["literal default of an unset reference", `api_key=\${KEY:-${credential}}`],
    ["quoted literal default", `api_key=\${KEY:-"${credential}"}`],
    ["literal after an angle placeholder", `token: <x>${credential}`],
    ["short literal before a reference", `api_key=Zq\${VAR}8vN3kLmP0w`],
    ["literal after a command substitution", `api_key=$(cat)${credential}`],
    ["literal after a quoted reference", `api_key="\${EMPTY}"${credential}`],
    ["literal split over two quoted pieces", `api_key="Zq8v""N3kLmP0w"`],
    ["punctuated literal after a reference directly after =", `CLIENT_SECRET=\${X}${punctuated}`],
    // The literal is data: a quoted piece's punctuation counts as in a quoted value.
    ["quoted punctuated literal after a reference", `api_key=\${X}"${["q7!A", ",9#z"].join("")}"`],
    ["punctuated literal default", `api_key=\${KEY:-${["q7!A", "(9#z"].join("")}}`],
    ["mixed-case variable name kept as literal text", `api_key=Zq8vN3k$LmP0wXy7Ab`],
    // Codex round 2: a variable after literal text, or an escaped one, is literal.
    ["CONSTANT_CASE variable after literal text", "api_key=Zq8vN3k$LMP0WXY7AB"],
    ["escaped CONSTANT_CASE variable in a quoted value", 'api_key="abc\\$ZQ8VN3K_LMP0WXY7AB"'],
    // Codex round 3: the baseline judges captured text as main did.
    ["quoted value whose command substitution holds an assignment", `api_key="ab$(token=${credential})"`],
    ["quoted key, literal after a braced reference", `"client_secret": "\${EMPTY}${credential}"`],
    ["quoted key, literal before a reference", `"client_secret": "${credential}\${VAR}"`],
    ["single-quoted key and value", `'api_key': '<x>${credential}'`],
    ["nested array", `{"api_key": ["\${EMPTY}${credential}"]}`],
    ["escaped quoted value", ['{"api_key": "\\u0024{EMPTY}', credential, '"}'].join("")],
    ["element", `<client_secret>\${X}${credential}</client_secret>`],
    ["credential inside a spaced command substitution, at its own key", `api_key=$(echo api_key=${credential})`],
    // Codex round 1: the baseline reading keeps every finding of the reference-free grammar.
    ["quoted credential followed by member access", `const api_key = "${credential}".trim();`],
    ["credential after a rejected variable-led path", `api_key=$BASE/token=${credential}`],
    ["credential inside a rejected angle placeholder", `api_key=<token=${credential}>`],
    ["credential two references deep", `api_key=$(token=$(token=${credential}))`],
    ["literal before a reference that leaves a word", `api_key=abcdefgh\${X}-ijk`],
  ])("flags a %s", (_label, content) => {
    expect(textRules(content)).toEqual(["credential_key_assignment"]);
  });

  it.each([
    ["braced reference", { api_key: `\${EMPTY}${credential}` }],
    ["angle placeholder", { client_secret: `<x>${credential}` }],
    ["literal default", { apiKey: `\${KEY:-${credential}}` }],
    ["array element", { access_token: [`\${EMPTY}${credential}`] }],
  ])("flags a payload member whose %s hides a literal", (_label, payload) => {
    expect(payloadRules(payload)).toEqual(["credential_key_assignment"]);
  });

  it.each([
    ["bare braced reference", "api_key=${API_KEY}"],
    ["bare command substitution", "api_key=$(op read key)"],
    ["bare angle placeholder", "api_key=<placeholder>"],
    ["empty default", "api_key=${API_KEY:-}"],
    ["quoted empty default", 'api_key=${API_KEY:-""}'],
    ["required-variable message", "api_key=${API_KEY:?unset}"],
    ["two references", "api_key=${PREFIX}${SUFFIX}"],
    ["bare CONSTANT_CASE variable", "api_key=$API_KEY"],
    ["bare lowercase variable", "api_key=$api_key_value"],
    ["quoted bare variable", 'api_key="$api_key_value"'],
    ["GitHub Actions expression", "token: ${{ secrets.GITHUB_TOKEN }}"],
    ["compact GitHub Actions expression", "token: ${{secrets.GITHUB_TOKEN}}"],
    ["quoted key with a bare reference", '"api_key": "${API_KEY}"'],
    ["quoted key with a bare variable", '"client_secret": "$CLIENT_SECRET"'],
    ["literal that is a path", "api_key=${BASE}/v1/keys"],
    ["quoted literal that is a path", 'token: "${HOME}/.config/app/token.json"'],
    ["literal that is a hyphenated word", "token: ${PREFIX}not-configured"],
    ["literal that is a URL", "token: ${SCHEME}https://example.com/callback"],
    ["short literal after a reference", "api_key=${KEY}abc"],
    ["generic type argument", "token: Array<string>"],
    ["quoted prefix concatenated with code", 'token="Bearer"+tokenValue'],
    // Codex round 4: code after a reference is never literal credential text.
    ["quoted reference followed by a method call", 'const api_key = "${API_KEY}".toUpperCase();'],
    ["quoted reference followed by an operator", 'token="${PREFIX}"+suffixValue'],
    ["reference followed by a member chain", "token=${X}.toUpperCase()"],
    ["element with a bare reference", "<client_secret>${X}</client_secret>"],
    ["element with a bare variable", "<client_secret>$CLIENT_SECRET</client_secret>"],
  ])("keeps a %s clean", (_label, content) => {
    expect(textRules(content)).not.toContain("credential_key_assignment");
  });

  it.each([
    ["bare reference", { api_key: "${API_KEY}" }],
    ["bare variable", { clientSecret: "$CLIENT_SECRET" }],
    ["bare lowercase variable", { api_key: "$api_key_value" }],
    ["placeholder", { access_token: "<your token>" }],
  ])("keeps a payload member holding a %s clean", (_label, payload) => {
    expect(payloadRules(payload)).not.toContain("credential_key_assignment");
  });

  it("applies one $NAME policy to both key-named rules", () => {
    const assign = (key: string, value: string) => `${key}=${value}`;
    const passwordKey = ["pass", "word"].join("");
    for (const bare of ["$DB_PASSWORD", "$db_password", '"$DB_PASSWORD"', "'$db_password'"]) {
      expect(textRules(assign(passwordKey, bare)), bare).toEqual([]);
      expect(textRules(assign("api_key", bare)), bare).toEqual([]);
    }
    // A CONSTANT_CASE variable expands to nothing, so the literal after it is judged by both rules.
    expect(textRules(assign(passwordKey, `$VAR-${literal}`))).toEqual(["password_assignment"]);
    expect(textRules(assign("api_key", `$VAR-${credential}`))).toEqual(["credential_key_assignment"]);
    // Any other `$name` inside a longer value is literal text in both rules, CONSTANT_CASE or not.
    expect(literalAfterReferences(`ab$cd${literal}`)).toBe(`ab$cd${literal}`);
    expect(expandRuntimeReferences(`ab$CD:${literal}`)).toBe(`ab$CD:${literal}`);
    expect(expandRuntimeReferences(`\${EMPTY}<x>$CD:${literal}`)).toBe(`:${literal}`);
    // Codex round 2: an escaped dollar keeps the variable after it literal in every spelling.
    const escaped = ["abc\\$", "ZQ8VN3K_LMP0WXY7AB"].join("");
    expect(textRules(`${passwordKey}="${escaped}"`)).toEqual(["password_assignment"]);
    expect(scanMutationSecrets({ [passwordKey]: ["abc$", "ZQ8VN3K_LMP0WXY7AB"].join("") })).toEqual([
      { rule: "password_assignment", path: `$.${passwordKey}` },
    ]);
    // A bare name is judged on the source, so a concatenation never reads as one name.
    expect(literalAfterReferences(`$var'${literal}'`)).toBe(`$var${literal}`);
    expect(expandRuntimeReferences("$_")).toBe("");
    // Double quotes inside a reference expand a variable; single quotes keep it literal.
    expect(expandRuntimeReferences(`\${PW:-"$FALLBACK"}`)).toBe("");
    expect(expandRuntimeReferences(`\${PW:-'$FALLBACK'}`)).toBe("$FALLBACK");
    // A `$` that ends an unclosed double-quoted default opens nothing; the unclosed reference stays literal.
    expect(expandRuntimeReferences(`\${PW:-"$`)).toBe(`\${PW:-"$`);
  });

  it("scans a baseline reading for a rule without structured spellings", () => {
    const rule: SecretRule = {
      name: "baseline-probe", mutationRule: "baseline_probe", regex: /(?!)/g,
      baseline: { regex: /probe=(\w+)/g, value: "" },
    };
    expect([...findSecretRuleMatches(rule, "probe=abc")]).toHaveLength(1);
  });

  it("blocks a referenced credential through the guard and never returns it", () => {
    const payload = { description: `api_key=\${EMPTY}"${credential}"` };
    expect(() => evaluateMutationGuard({ author: "agent", payload, settings: blockSettings }))
      .toThrow(/Mutation blocked by secret guard \(credential_key_assignment\)/);
    expect(JSON.stringify(scanMutationSecrets(payload))).not.toContain(credential);
  });

  it("keeps every new value grammar path linear", () => {
    const rule = ruleNamed("credential_key_assignment");
    const inputs = [
      `api_key=${"${A}".repeat(100_000)}`,
      `api_key=${"$(a)".repeat(100_000)}`,
      `api_key=${"<a>".repeat(100_000)}`,
      `api_key=${"$A".repeat(200_000)}`,
      `api_key=${"${".repeat(200_000)}`,
      `api_key=${"$(".repeat(200_000)}`,
      "token=/".repeat(60_000),
      `token=${"a".repeat(60)}$1`.repeat(10_000),
      '"token":"${A}token"'.repeat(20_000),
      '"token":${A}"token":${A}'.repeat(20_000),
      'token="a""a"'.repeat(30_000),
      `token=\${A:-${'"x"'.repeat(100_000)}`,
      `api_key=\${A:-${"${B}".repeat(100_000)}}`,
    ];
    const started = performance.now();
    const counts = inputs.map((input) => Array.from(findSecretRuleMatches(rule, input)).length);
    expect(performance.now() - started).toBeLessThan(5_000);
    // None of these spells a credential: every value is references, paths or short literals.
    expect(counts).toEqual(inputs.map(() => 0));
  });
});

describe("a key inside a rejected reference value is still judged (pm-bn3ppf)", () => {
  const passwordKey = ["pass", "word"].join("");

  it("reports a password assignment inside a spaced command substitution in both consumers", async () => {
    const content = `${passwordKey}=$(echo ${passwordKey}=${literal})`;
    expect(await gateRules(content)).toEqual(["password-assignment"]);
    expect(textRules(content)).toEqual(["password_assignment"]);
  });

  it("reaches a password assignment two references deep, and inside a placeholder or variable-led value", async () => {
    for (const content of [
      `${passwordKey}=$(echo ${passwordKey}=$(echo ${passwordKey}=${literal}))`,
      `${passwordKey}=<x ${passwordKey}=${literal}>`,
      `${passwordKey}=\${A:?${passwordKey}=${literal}}`,
    ]) {
      expect(await gateRules(content), content).toEqual(["password-assignment"]);
      expect(textRules(content), content).toEqual(["password_assignment"]);
    }
  });

  it("keeps a variable literal when the grammar cut its word short", async () => {
    // Codex round 3: the password grammar stops before `:`, `/` and `?`, so the
    // variable is not known to be the whole value and stays literal, as on main.
    for (const separator of [":", "/", "?", "]", "}", ",", ")"]) {
      const content = `${passwordKey}=$PW_PREFIX${separator}${credential}`;
      expect(await gateRules(content), content).toEqual(["password-assignment"]);
      expect(textRules(content), content).toEqual(["password_assignment"]);
    }
    expect(expandRuntimeReferences("$PW_PREFIX", false)).toBe("$PW_PREFIX");
    expect(literalAfterReferences("$pw", false)).toBe("$pw");
    // A word-ending character after the variable keeps it a bare reference.
    for (const content of [
      `${passwordKey}=$DB_PASSWORD;`, `${passwordKey}=$DB_PASSWORD) `, `(${passwordKey}=$db_password, next)`,
      `{"cmd": "${passwordKey}=$DB_PASSWORD"}`, `${passwordKey}=$DB_PASSWORD${";".repeat(80)}`.slice(0, 30),
    ]) {
      expect(textRules(content), content).toEqual([]);
    }
  });

  it("reports a credential-key assignment inside a referenced value whose literal is rejected", () => {
    // The outer literal is a path, so the outer value is rejected; the key inside it keeps its own verdict.
    expect(textRules(`api_key=\${DIR}/x/token=${credential}`)).toEqual(["credential_key_assignment"]);
  });

  it("keeps reference values without an inner assignment clean", async () => {
    for (const content of [
      `${passwordKey}=$(op read vault/item)`, `${passwordKey}=\${A:-\${B}} and more`, "api_key=${DIR}/x/y",
      // An inner assignment whose own value is too short is judged and stays clean.
      `${passwordKey}=$(echo ${passwordKey}=short)`,
    ]) {
      expect(await gateRules(content), content).toEqual([]);
      expect(textRules(content), content).toEqual([]);
    }
  });

  it("rescans each rejected value once, so the scan stays linear", () => {
    const passwordRule = ruleNamed("password_assignment");
    const credentialKeyRule = ruleNamed("credential_key_assignment");
    // Spelled without template escapes, so no fixture reads as an escaped pattern.
    const open = "${";
    const inputs: Array<[SecretRule, string]> = [
      [passwordRule, `${passwordKey}=$(echo ${passwordKey}=$(a) `.repeat(20_000)],
      [passwordRule, `${passwordKey}=$(a ${passwordKey}=${open}B}) `.repeat(20_000)],
      [passwordRule, `${passwordKey}=${open}A:-${`${passwordKey}=`.repeat(2_000)}}`.repeat(20)],
      [credentialKeyRule, `token=${open}A}${"token=${A}".repeat(50_000)}`],
      [credentialKeyRule, "api_key=${D}/token=${D}/".repeat(20_000)],
      [passwordRule, `${passwordKey}=$(a ${passwordKey}=$(b) ${passwordKey}=$(c)) `.repeat(15_000)],
      [passwordRule, `${passwordKey}=<x ${passwordKey}=$A> `.repeat(20_000)],
      [credentialKeyRule, '"token":"a"$X'.repeat(20_000)],
    ];
    const started = performance.now();
    const counts = inputs.map(([rule, input]) => Array.from(findSecretRuleMatches(rule, input)).length);
    expect(performance.now() - started).toBeLessThan(5_000);
    // The repeated default word is one concatenated value; in the last input a
    // variable after literal text stays literal, so each `"a"$X"token"` spells eight characters.
    expect(counts).toEqual([0, 0, 1, 0, 0, 0, 0, 19_999]);
  });
});

describe("payload property names are scanned and never echoed in paths (pm-x07qz2)", () => {
  it("reports a credential-shaped property name by its positional placeholder", () => {
    const findings = scanMutationSecrets({ metadata: { owner: "ops", [githubToken]: "x" } });
    expect(findings).toEqual([{ rule: "github_token", path: "$.metadata[key 1]", property_name: true }]);
    expect(JSON.stringify(findings)).not.toContain(githubToken);
  });

  it("uses the placeholder in every finding under a flagged name", () => {
    const findings = scanMutationSecrets({ metadata: { [githubToken]: { password: literal, nested: [githubToken] } } });
    expect(findings).toEqual([
      { rule: "github_token", path: "$.metadata[key 0]", property_name: true },
      { rule: "github_token", path: "$.metadata[key 0].nested[0]" },
      { rule: "password_assignment", path: "$.metadata[key 0].password" },
    ]);
    expect(JSON.stringify(findings)).not.toContain(githubToken);
  });

  it("reports a name and its value apart when both match at one path", () => {
    expect(scanMutationSecrets({ [githubToken]: githubToken })).toEqual([
      { rule: "github_token", path: "$[key 0]", property_name: true },
      { rule: "github_token", path: "$[key 0]" },
    ]);
  });

  it("scans names with every rule, including key-named and private-context rules", () => {
    const home = ["", "home", "alice", "notes.md"].join("/");
    expect(scanMutationSecrets({ files: { [home]: "linked" } })).toEqual([
      { rule: "absolute_home_path", path: "$.files[key 0]", property_name: true },
    ]);
    expect(scanMutationSecrets({ fields: { [`api_key=${credential}`]: 1 } })).toEqual([
      { rule: "credential_key_assignment", path: "$.fields[key 0]", property_name: true },
    ]);
  });

  it("keeps paths for ordinary names and the member judgment's paths unchanged", () => {
    expect(scanMutationSecrets({ metadata: { notes: { password: literal } } })).toEqual([
      { rule: "password_assignment", path: "$.metadata.notes.password" },
    ]);
    expect(scanMutationSecrets({ api_key: credential })).toEqual([
      { rule: "credential_key_assignment", path: "$.api_key" },
    ]);
    // Array indices are positions, never scanned as names.
    expect(scanMutationSecrets({ list: [literal, { password: literal }] })).toEqual([
      { rule: "password_assignment", path: "$.list[1].password" },
    ]);
  });

  it("blocks a credential-shaped property name through the guard the CLI and MCP adapters use", () => {
    expect(() => evaluateMutationGuard({ author: "agent", payload: { metadata: { [githubToken]: true } }, settings: blockSettings }))
      .toThrow(/Mutation blocked by secret guard \(github_token\)/);
    const advised = evaluateMutationGuard({
      author: "agent", payload: { metadata: { [githubToken]: true } }, settings: { ...blockSettings, secret_guard: "advise" },
    });
    expect(advised.warnings).toEqual(["secret_guard_detected:1:rules=github_token"]);
    expect(JSON.stringify(advised)).not.toContain(githubToken);
  });

  it("judges a repeated property name once per scan", () => {
    const payload = Array.from({ length: 5_000 }, (_, index) => ({ [githubToken]: index, title: "row" }));
    const started = performance.now();
    const findings = scanMutationSecrets({ rows: payload });
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(findings).toHaveLength(5_000);
    expect(findings[4_999]).toEqual({ rule: "github_token", path: "$.rows[4999][key 0]", property_name: true });
  });
});
