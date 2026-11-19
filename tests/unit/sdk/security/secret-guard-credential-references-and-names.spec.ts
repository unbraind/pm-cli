/**
 * Regression coverage for pm-hw00c2 (credential_key_assignment judges a
 * referenced value by the literal it spells, and one `$NAME` policy holds for
 * every key-named rule), pm-bn3ppf (a key inside a rejected reference value
 * is still judged) and pm-x07qz2 (payload property names are scanned, and a
 * flagged name never appears in a finding path).
 */
import { describe, expect, it } from "vitest";
import { evaluateMutationGuard, scanMutationSecrets } from "../../../../src/sdk/mutation-guard.js";
import { SECRET_RULES, _testOnly, expandRuntimeReferences, findSecretRuleMatches, literalAfterReferences, type SecretRule } from "../../../../src/core/shared/secret-rules.js";
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
    // Greptile: referenced credentials inside rejected values, punctuation-led and quoted data.
    ["referenced credential inside a rejected referenced value", `api_key=\${DIR}/token=\${X}${credential}`],
    ["punctuation-led literal after a quoted reference", `api_key="\${EMPTY}"!${credential}`],
    ["quoted dotted literal after a reference", `"api_key": "\${EMPTY}.${credential}"`],
    // Greptile: a single `&` is data; only `&&`, `||` and `|` end a referenced value.
    ["YAML literal holding a single ampersand after a reference", `api_key: \${EMPTY}Zq8&vN3kLmP0wXy7Ab`],
    // Greptile: punctuation that is not a binary operator stays literal data after a reference.
    ["YAML literal led by an exclamation mark after a reference", `api_key: \${EMPTY}!${credential}`],
    // Greptile: a field separator alone ends flow-YAML data, and an ALL-CAPS angle name is a placeholder.
    ["flow-YAML literal after an angle placeholder", `{token: <x>${credential}, other: 1}`],
    ["YAML literal after an ALL-CAPS placeholder", `api_key: <TOKEN>${credential}`],
    ["YAML literal after a CONSTANT_CASE placeholder", `api_key: <API_KEY>${credential}`],
    ["YAML literal after a hyphenated placeholder", `api_key: <your-key>${credential}`],
    // Greptile: a literal that starts before the reference is never member access on it.
    ["dotted literal that starts before a reference", `token=.Zq8\${EMPTY}vN3k-LmP0wXy7Ab`],
  ])("flags a %s", (_label, content) => {
    expect(textRules(content)).toEqual(["credential_key_assignment"]);
  });

  it.each([
    ["braced reference", { api_key: `\${EMPTY}${credential}` }],
    ["angle placeholder", { client_secret: `<x>${credential}` }],
    ["literal default", { apiKey: `\${KEY:-${credential}}` }],
    ["dotted literal after a reference", { api_key: `\${EMPTY}.${credential}` }],
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
    // Codex round 5: shell control operators end a referenced value.
    ["command substitution followed by ||", "api_key=$(get_api_key)||handle_error"],
    ["reference followed by &&", "api_key=${KEY}&&run_next_step"],
    ["variable piped to a command", "token=$TOKEN|tee_output_file"],
    // Codex round 6: optional chaining and nullish coalescing after a reference are code.
    ["optional chain after a variable", "const api_key=$TOKEN?.access_token;"],
    ["nullish fallback after a variable", "const api_key=$TOKEN??getDefaultToken();"],
    ["compact JSON with a bare variable", '{"api_key":"$API_KEY","other":"x"}'],
    // Codex round 8: member access on a reference, even before an operator, is code.
    ["arithmetic on a reference member", "const token = $TOKEN.length+1;"],
    // Codex round 17: a binary operator after a reference is code.
    ["sum after a reference", "const token=$TOKEN+tokenSuffix;"],
    ["difference after a reference", "const token=$TOKEN-tokenOffset;"],
    ["product after a reference", "const token=${COUNT}*multiplierValue;"],
    // Codex round 13: a call after a type assertion is code.
    ["call after a type assertion", "const api_key = <string>get_auth_token();"],
    // Codex round 14: a spaced call and a constant after a type assertion are code too.
    ["spaced call after a type assertion", "const api_key = <string>get_auth_token ();"],
    ["constant after a type assertion", "const api_key = <string>DEFAULT_TOKEN;"],
    // Codex round 15: an optional call or nullish fallback after a type assertion is code.
    ["optional call after a type assertion", "const token = <string>get_auth_token?.();"],
    ["nullish fallback after a type assertion", "const token = <string>getAuthTokenValue ?? fallback;"],
    // Codex round 16: after `=`, every value led by a type assertion is code.
    ["logical fallback after a type assertion", "const token = <string>auth_token || fallback;"],
    ["index after a type assertion", "const token = <string>auth_token[0];"],
    ["shell redirection after an assignment", "api_key=<input_file_name"],
    // Greptile: a type assertion in an object property, and member access after nested references, are code.
    ["type assertion in an object property", "({ token: <string>auth_token ?? fallback })"],
    ["optional call in an object property", "({ token: <string>get_auth_token?.() })"],
    ["member access after nested references", "const token = $($(getToken)).length+1;"],
    // Codex round 20: expression code after a type assertion may sit on the next line.
    ["type assertion before a closing brace on the next line", "const config = {\n  token: <string>auth_token\n};"],
    // Codex round 21: an angle span holding a TypeScript type is an assertion whatever follows it.
    ["type assertion before an operator in an object property", "({ token: <string>auth_token + suffix })"],
    ["type assertion before as", "({ token: <string>auth_token as string })"],
    ["generic type assertion", "({ token: <Record<string, string>>token_map })"],
    ["array type assertion", "({ token: <string[]>token_list })"],
    // Codex round 23: acronym-prefixed type names are TypeScript types too.
    ["acronym-prefixed type assertion", "({ token: <APIKey>auth_token })"],
    ["interface-prefixed type assertion", "({ token: <IAuthToken>auth_token })"],
    // Codex round 25: qualified and union types are TypeScript types too.
    ["qualified type assertion", "({ token: <auth.Token>auth_token })"],
    ["union type assertion", "({ token: <string|undefined>auth_token })"],
    // Codex round 32: literal types are TypeScript types too.
    ["string literal type assertion", 'const config = { token: <"bearer">auth_token };'],
    ["numeric literal union type assertion", "const config = { token: <1|2>auth_token };"],
    // Codex round 41: structural types are TypeScript types too.
    ["structural type assertion", "const cfg = { token: <{value:string}>auth_token };"],
    ["intersection with a structural type", "const cfg = { token: <Token&{}>auth_token };"],
    ["quoted parenthesis inside a command substitution", "const token = $('(').length+1;"],
    // CodeRabbit and Greptile: member access after a nested reference, and XOR after a reference, are code.
    ["member access after a nested braced reference", "token=${A:-${B}}.length+1"],
    ["XOR after a reference", "const token=$TOKEN^maskValue;"],
    // Codex round 26: a non-null assertion before an operator or member access is code.
    ["non-null assertion before member access", "const token = $TOKEN!.access_token;"],
    ["non-null assertion before an operator", "const token = $TOKEN!+tokenSuffix;"],
    // Codex round 28: code operators after a quoted reference keep the quoted reading.
    ["non-null assertion after a quoted reference", 'const token="${TOKEN}"!.length+1;'],
    ["XOR after a quoted reference", 'const token="${TOKEN}"^maskValue;'],
    ["subtraction after a quoted reference", 'const token="${TOKEN}"-tokenOffset;'],
    // CodeRabbit: bitwise AND directly after a reference is code.
    ["bitwise AND after a reference", "const token=$TOKEN&maskValue;"],
    // Codex round 29: remainder after a quoted reference is code too.
    ["remainder after a quoted reference", 'const token="${TOKEN}"%maskValue;'],
    // A lowercase angle span after `=`, or before expression code, is code too.
    ["placeholder-shaped assertion after an assignment", `api_key=<t>${credential}`],
    ["placeholder-shaped assertion before expression code", "({ token: <t>auth_token ?? fallback })"],
    ["compact JSON array of bare variables", '{"password":["$DB_PASSWORD","x"]}'],
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
    expect(textRules(assign("api_key", `$VAR"${credential}"`))).toEqual(["credential_key_assignment"]);
    // Any other `$name` inside a longer value is literal text in both rules, CONSTANT_CASE or not.
    expect(literalAfterReferences(`ab$cd${literal}`)).toBe(`ab$cd${literal}`);
    expect(expandRuntimeReferences(`ab$CD:${literal}`)).toBe(`ab$CD:${literal}`);
    expect(expandRuntimeReferences(`\${EMPTY}<x>$CD:${literal}`)).toBe(`:${literal}`);
    // An escaped dollar in a decoded string literal decodes to `$`, as JSON and JavaScript readers do, so a
    // whole-value variable stays a placeholder (a template-literal fixture's escaped interpolation reads the same).
    expect(textRules(['const cfg = {"', passwordKey, '":"\\$', "DB_PASSWORD", '"};'].join(""))).toEqual([]);
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
      name: "baseline-probe", mutationRule: "baseline_probe", category: "credential", regex: /(?!)/g,
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

  // Each oversized input is its own case, so a slow instrumented host never stacks them into one test's budget.
  it.each([
    // Codex round 20: a reference of millions of characters.
    ["reference", () => `api_key=\${${"x".repeat(16_000_000)}}${credential}`, 1],
    // Codex round 27: a literal run of millions of characters after a reference is one character class too.
    ["literal run after a reference", () => `api_key=\${X}${"a".repeat(16_000_000)}`, 0],
    ["ampersand run after a reference", () => `api_key=\${X}${"a&".repeat(4_000_000)}`, 0],
    // A quoted value of millions of characters, which overflowed even before the referenced reading.
    ["quoted value", () => `api_key="${"a".repeat(16_000_000)}"`, 0],
    // Codex round 34: millions of member segments after a reference no longer exhaust the stack.
    ["member chain after a reference", () => `api_key=\${X}"${"a.".repeat(8_000_000)}a"`, 0],
  ] as const)("reads a %s of millions of characters without exhausting the stack", (_label, build, minimum) => {
    const rule = ruleNamed("credential_key_assignment");
    const matches = [...findSecretRuleMatches(rule, build())];
    expect(matches.length).toBeGreaterThanOrEqual(minimum);
  });

  it("finds where leading references end, stopping at anything that is not a closed reference", () => {
    const { leadingReferencesEnd } = _testOnly;
    expect(leadingReferencesEnd("${A:-${B}}$C<x>rest")).toBe("${A:-${B}}$C<x>".length);
    expect(leadingReferencesEnd("$($(a))x")).toBe(7);
    // An unclosed bracket, an angle span reopened before it closes, an unclosed angle span and `$` without a name are not references.
    for (const text of ["${unclosed", "$(unclosed", "<a<b>", "<a", "$1x", "plain"]) expect(leadingReferencesEnd(text), text).toBe(0);
    // Quoted spans and escapes never close a reference.
    expect(leadingReferencesEnd("$(')')x")).toBe(6);
    expect(leadingReferencesEnd('$("a\\")b")x')).toBe('$("a\\")b")'.length);
    expect(leadingReferencesEnd("$(a\\)b)x")).toBe("$(a\\)b)".length);
    expect(leadingReferencesEnd("$('open")).toBe(0);
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
    // Codex round 6: the look-ahead bound counts code units, so astral characters cannot end it early.
    const astral = `${passwordKey}=$PW_PREFIX]${"\u{1F600}".repeat(40)}${credential}`;
    expect(textRules(astral)).toEqual(["password_assignment"]);
    // Greptile: a closed quoted value followed by JSON structure ends its word.
    expect(textRules(`{"${passwordKey}":"$DB_PASSWORD","other":"x"}`)).toEqual([]);
    expect(textRules(`{"other":"x","${passwordKey}":"$DB_PASSWORD"}`)).toEqual([]);
    expect(textRules(`[{"${passwordKey}":"$DB_PASSWORD"},{"other":true}]`)).toEqual([]);
    expect(textRules(`{"${passwordKey}":"$DB_PASSWORD","list":[1]}`)).toEqual([]);
    expect(textRules(`{"${passwordKey}":"$DB_PASSWORD"]x`)).toEqual(["password_assignment"]);
    // Greptile: a bracket after structure starts an element only when structure follows it.
    expect(textRules(`${passwordKey}="$DB_PASSWORD"][${literal}`)).toEqual(["password_assignment"]);
    expect(textRules(`${passwordKey}="$DB_PASSWORD"],{${literal}`)).toEqual(["password_assignment"]);
    expect(textRules(`[{"${passwordKey}":"$DB_PASSWORD"},["x"]]`)).toEqual([]);
    // Greptile: a quoted array element is structured too, in either position.
    expect(textRules(`{"${passwordKey}":["$DB_PASSWORD","x"]}`)).toEqual([]);
    expect(textRules(`{"${passwordKey}":["x","$DB_PASSWORD"]}`)).toEqual([]);
    // CodeRabbit: a JSON scalar sibling after a quoted array element is structure too, a digit-led word is not.
    for (const sibling of ["1", "-2.5", "true", "false", "null"]) {
      expect(textRules(`{"${passwordKey}":["$DB_PASSWORD",${sibling}]}`), sibling).toEqual([]);
    }
    expect(textRules(`{"${passwordKey}":["$DB_PASSWORD",1${literal}]}`)).toEqual(["password_assignment"]);
    // Greptile: a bare scalar after a closed container, a long quoted key, and pretty-printed JSON are structured too.
    for (const element of ["1", "true", "null"]) {
      expect(textRules(`[{"${passwordKey}":"$DB_PASSWORD"},${element}]`), element).toEqual([]);
    }
    expect(textRules(`{"production-database-connection-readonly-account-${passwordKey}":"$DB_PASSWORD","x":1}`)).toEqual([]);
    expect(textRules(`{${" ".repeat(80)}"${passwordKey}":"$DB_PASSWORD","x":1}`)).toEqual([]);
    // Greptile: after a quoted option name alone, a bare scalar and literal continue the shell argument.
    expect(textRules(`mysql --'${passwordKey}'="$DB_PASSWORD",1,${literal}`)).toEqual(["password_assignment"]);
    // Codex round 38: a quoted shell option is not an object member, so a quoted suffix continues the argument.
    expect(textRules(`mysql --'${passwordKey}'="$DB_PASSWORD","${literal}"`)).toEqual(["password_assignment"]);
    // Greptile: an array that starts with a JSON number or literal is structure too.
    for (const element of ["[1]", "[-2]", "[true]", "[null]", "{}"]) {
      expect(textRules(`[{"${passwordKey}":"$DB_PASSWORD"},${element}]`), element).toEqual([]);
      expect(textRules(`[{'${passwordKey}':'$DB_PASSWORD'},${element}]`), element).toEqual([]);
    }
    expect(textRules(`${passwordKey}="$DB_PASSWORD"][trueSecret${literal}`)).toEqual(["password_assignment"]);
    // Codex round 14: after an unquoted key, a comma and a quoted piece continue the shell word.
    expect(await gateRules(`${passwordKey}="$PW_PREFIX","${credential}"`)).toEqual(["password-assignment"]);
    expect(textRules(`${passwordKey}="$PW_PREFIX","${credential}"`)).toEqual(["password_assignment"]);
    // Codex round 15: at the top level a closing brace before a quote is literal data.
    expect(textRules(`${passwordKey}=$PW_PREFIX}"${literal}"`)).toEqual(["password_assignment"]);
    expect(textRules(`${passwordKey}=$PW_PREFIX)"${literal}"`)).toEqual(["password_assignment"]);
    // Codex round 14: a variable that ends a command substitution ends its word at the closing parenthesis.
    for (const nested of [
      `${passwordKey}="$(get-secret --${passwordKey}=$VAULT_PASSWORD)"`,
      // Codex round 16: a quoted inner variable ends its word at the substitution's closing parenthesis too.
      `${passwordKey}="$(get-secret --${passwordKey}="$VAULT_PASSWORD")"`,
      // CodeRabbit: only the closer of the enclosing reference ends the inner word (asserted below).
      // Codex round 32: inside a substitution, a shell control operator ends the inner word.
      `${passwordKey}=$(get --${passwordKey}=$VAULT_PASSWORD|filter)`,
      `${passwordKey}=$(get --${passwordKey}="$VAULT_PASSWORD"||fallback)`,
      `${passwordKey}=$(get --${passwordKey}=$VAULT_PASSWORD; next)`,
      // Quoted text elsewhere in the substitution leaves the inner key in shell context.
      `${passwordKey}=$(echo "a" "b" --${passwordKey}=$VAULT_PASSWORD|filter)`,
      `${passwordKey}=$(get --${passwordKey}=$VAULT_PASSWORD|filter "a" "b")`,
      // Codex round 33: a redirection, and a control operator the value grammar reads, end the inner word too.
      `${passwordKey}=$(get --${passwordKey}=$VAULT_PASSWORD>/dev/null)`,
      `${passwordKey}=$(get --${passwordKey}=$VAULT_PASSWORD&&handle_error)`,
      // A quoted piece or nested reference before the operator is skipped whole.
      `${passwordKey}=$(get --${passwordKey}=$VAULT_PASSWORD'a&b'&&handle_error)`,
      `${passwordKey}=$(get --${passwordKey}=$VAULT_PASSWORD$(x&y)&&handle_error)`,
      // Codex round 29: a key word that names a braced reference's parameter is not an assignment.
      `${passwordKey}=\${${passwordKey.toUpperCase()}:START_OFFSET:8}`,
      `${passwordKey}=\${#${passwordKey.toUpperCase()}:0:8}`,
      // Codex round 23: a double-quoted closer inside the substitution is not its closer.
      `${passwordKey}=$(printf ")"; get --${passwordKey}=$VAULT_PASSWORD)\${SUFFIX}`,
      // Codex round 24: a substitution nested inside double quotes is still a reference with its own closer.
      `${passwordKey}=$(get --x="$(get --${passwordKey}=$VAULT_PASSWORD)")`,
      // An escaped closer inside the substitution is not its closer either.
      `${passwordKey}=$(printf \\); get --${passwordKey}=$VAULT_PASSWORD)\${SUFFIX}`,
      // A sibling substitution before the enclosing one is not the inner key's reference.
      `${passwordKey}="$(prep)$(get-secret --${passwordKey}=$VAULT_PASSWORD)"`,
      // Codex round 18: the inner word ends at the substitution even when another reference follows.
      `${passwordKey}="$(get-secret --${passwordKey}=$VAULT_PASSWORD)\${SUFFIX}"`,
    ]) {
      expect(await gateRules(nested), nested).toEqual([]);
      expect(textRules(nested), nested).toEqual([]);
    }
    // A braced reference the quoted piece cuts short closes where the text closes it. In one that never
    // closes, the inner quoted variable is still a whole word, because whitespace follows it.
    expect(textRules(`${passwordKey}="\${A:?--${passwordKey}="$VAULT_PASSWORD"}"`)).toEqual([]);
    expect(textRules(`${passwordKey}="\${A:?--${passwordKey}="$VAULT_PASSWORD" x}"`)).toEqual([]);
    expect(textRules(`${passwordKey}="$(get --${passwordKey}="$VAULT_PASSWORD" and more`)).toEqual([]);
    // Greptile: skipping a parameter name still scans the word after it for an inner assignment.
    const defaulted = `${passwordKey}=\${${passwordKey.toUpperCase()}:-$(echo ${passwordKey}=${literal})}`;
    expect(await gateRules(defaulted)).toEqual(["password-assignment"]);
    expect(textRules(defaulted)).toEqual(["password_assignment"]);
    // Greptile: an operator inside quoted text, or inside a braced reference's word, is data, not a shell separator.
    for (const content of [
      `${passwordKey}=$(echo "${passwordKey}=$VAULT_PASSWORD|${literal}")`,
      `${passwordKey}=\${A:?${passwordKey}=abc&defghijk}`,
    ]) {
      expect(await gateRules(content), content).toEqual(["password-assignment"]);
      expect(textRules(content), content).toEqual(["password_assignment"]);
    }
    // CodeRabbit: a parenthesis inside a braced reference is literal data, not the reference's closer.
    const mismatched = `${passwordKey}=\${A:?${passwordKey}=$VAULT_PASSWORD)${credential}}`;
    expect(await gateRules(mismatched)).toEqual(["password-assignment"]);
    expect(textRules(mismatched)).toEqual(["password_assignment"]);
    // Codex round 13: a number counts only as a complete token that a delimiter ends.
    expect(textRules(`${passwordKey}="$DB_PASSWORD"][1${credential}]`)).toEqual(["password_assignment"]);
    expect(textRules(`[{"${passwordKey}":"$DB_PASSWORD"},[1.5e3, 2]]`)).toEqual([]);
    // Greptile: structure followed by more word text is still one shell word.
    expect(textRules(`${passwordKey}="$PW_PREFIX"],${literal}`)).toEqual(["password_assignment"]);
    // Codex round 10: a quote after an unquoted value may open a concatenated piece, so
    // the variable keeps main's literal reading, even where the quote closes a string.
    expect(textRules(`${passwordKey}=$DB_PASSWORD" correct horse battery staple"`)).toEqual(["password_assignment"]);
    expect(textRules(`["${passwordKey}=$DB_PASSWORD"], "next"`)).toEqual(["password_assignment"]);
    expect(textRules(`{"cmd": "${passwordKey}=$DB_PASSWORD"}`)).toEqual(["password_assignment"]);
    // Codex round 8: literal punctuation after the variable is part of its word.
    expect(await gateRules(`${passwordKey}=$DB_PASSWORD/++//++/`)).toEqual(["password-assignment"]);
    expect(textRules(`${passwordKey}=$DB_PASSWORD/++//++/`)).toEqual(["password_assignment"]);
    // Codex round 9: an opening bracket, brace or quoted piece after an unquoted variable continues its word.
    for (const suffix of [`[${credential}]`, `{${credential}}`, `,"${credential}"`]) {
      expect(textRules(`${passwordKey}=$PW_PREFIX${suffix}`), suffix).toEqual(["password_assignment"]);
    }
    expect(textRules(`${passwordKey}="$PW_PREFIX""${credential}"`)).toEqual(["password_assignment"]);
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
      `${passwordKey}=$DB_PASSWORD${";".repeat(80)}`.slice(0, 30),
    ]) {
      expect(textRules(content), content).toEqual([]);
    }
  });

  it("keeps a quoted inner credential value intact (CodeRabbit)", () => {
    // The quoted body is data, so its `&` is not a shell operator and the credential after the reference is judged.
    expect(textRules(`api_key=$(token="\${EMPTY}abc&${credential}")`)).toContain("credential_key_assignment");
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
      // Codex round 39: a long capitalized angle name with a trailing comma is judged in linear time.
      [credentialKeyRule, `api_key: <A${"a".repeat(64_000)},>Zq8vN3kLmP0wXy7Ab`],
      // CodeQL and Greptile: a literal type union is read without trying members two ways.
      [credentialKeyRule, `token: <1${"|123".repeat(5_000)}!>Zq8vN3kLmP0wXy7Ab`],
      // Codex round 25: many cut references share one bounded look-ahead.
      [passwordRule, `${passwordKey}="${"$(".repeat(256_000)}${passwordKey}=$VAULT_PASSWORD"`],
    ];
    const started = performance.now();
    const counts = inputs.map(([rule, input]) => Array.from(findSecretRuleMatches(rule, input)).length);
    expect(performance.now() - started).toBeLessThan(5_000);
    // The repeated default word is one concatenated value; in the last input a
    // variable after literal text stays literal, so each `"a"$X"token"` spells eight characters.
    // The long angle-name and literal-type inputs are placeholders followed by a credential. In the
    // cut-reference input no opener ever closes, so the inner variable keeps main's literal reading.
    expect(counts).toEqual([0, 0, 1, 0, 0, 0, 0, 19_999, 1, 1, 1]);
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
