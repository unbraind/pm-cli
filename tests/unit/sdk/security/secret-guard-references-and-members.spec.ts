/**
 * Regression coverage for pm-3627y1 (linear user-at-private-host scan),
 * pm-ycgb5g (a reference is a password placeholder only when it is the whole
 * value) and pm-3fbj1f (structured payload members are judged under their
 * property names).
 */
import { describe, expect, it } from "vitest";
import { evaluateMutationGuard, scanMutationSecrets } from "../../../../src/sdk/mutation-guard.js";
import {
  SECRET_RULES,
  acceptsStructuredValue,
  expandRuntimeReferences,
  findSecretRuleMatches,
  literalAfterReferences,
  structuredKeyShape,
  type SecretRule,
} from "../../../../src/core/shared/secret-rules.js";
import { createScriptHarness } from "../../../helpers/scriptModule.js";

const harness = createScriptHarness();
const gateModule = () =>
  harness.importModule<{ scanContent(file: string, content: string): Array<{ rule: string }> }>(
    "scripts/check-secrets-lib.mjs",
  );
const blockSettings = { require_attributed_author: false, secret_guard: "block", stale_in_progress_hours: 72 } as const;
const ruleNamed = (mutationRule: string) => SECRET_RULES.find((rule) => rule.mutationRule === mutationRule)! as SecretRule;
const textRules = (content: string) => scanMutationSecrets({ description: content }).map(({ rule }) => rule);

// Built at runtime so this file stays clean under the repository scan it exercises.
const privateHosts = [["10", "42", "0", "1"], ["172", "16", "0", "1"], ["192", "168", "7", "9"]].map((parts) => parts.join("."));
const literal = ["Synthetic", "Only123"].join("");
const credential = ["Zq8vN3k", "LmP0wXy7Ab"].join("");
// Short identifiers keep assignment-shaped source lines such as `password: pw` clean.
const pw = ["Synthetic", "Only123!"].join("");

describe("user_at_private_host scans in linear time (pm-3627y1)", () => {
  const rule = ruleNamed("user_at_private_host");
  const legacy = new RegExp(String.raw`\b` + rule.regex.source.replace(/^\(\?<!\[A-Za-z0-9\._-\]\)/u, ""), "g");

  it("scans 32 KB of hyphenated, dotted or underscored text well within budget", () => {
    const inputs = ["a-".repeat(16_000), "token-".repeat(5_400), "a.".repeat(16_000), "x_".repeat(16_000), "a-b.".repeat(8_000)];
    const started = performance.now();
    for (const input of inputs) expect([...findSecretRuleMatches(rule, input)]).toEqual([]);
    // Before the fix one 32 KB hyphen run alone cost about a second.
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("finishes a 512 KB run whose quadratic scan would take minutes", () => {
    const started = performance.now();
    expect([...findSecretRuleMatches(rule, "a-".repeat(262_144))]).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it.each(privateHosts.flatMap((host) => [
    `user@${host}`, `-user@${host}`, `.user@${host}`, `first.last@${host}`, `a-b_c@${host}`,
    `ssh to deploy-bot@${host} now`, `(ops@${host})`, `"svc@${host}"`, `x--y..z@${host}`,
  ]))("still detects %s in both consumers", async (content) => {
    const gate = await gateModule();
    expect(gate.scanContent("docs/runbook.md", content).map(({ rule }) => rule)).toContain("user-at-private-host");
    expect(textRules(content)).toContain("user_at_private_host");
  });

  it("detects every spelling the word-boundary pattern detected", () => {
    const prefixes = ["", " ", "(", "-", ".", "_", "x", "é", "@", "--"];
    const locals = ["user", "-user", ".user", "a.b-c_d", "u", "_x"];
    const suffixes = ["", " ", ".", "x", "1", ")"];
    let compared = 0;
    for (const host of privateHosts) {
      for (const prefix of prefixes) {
        for (const local of locals) {
          for (const suffix of suffixes) {
            const content = `${prefix}${local}@${host}${suffix}`;
            legacy.lastIndex = 0;
            if (legacy.test(content)) {
              compared += 1;
              expect([...findSecretRuleMatches(rule, content)].length, content).toBeGreaterThan(0);
            }
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(500);
  });

  it("keeps public addresses and malformed octets clean", () => {
    for (const content of ["user@8.8.8.8", `user@${["10", "0", "0", "256"].join(".")}`, `user@${privateHosts[0]}x`]) {
      expect(textRules(content), content).not.toContain("user_at_private_host");
    }
  });
});

describe("password placeholders are whole-value references (pm-ycgb5g)", () => {
  const bothConsumers = async (content: string) => ({
    gate: (await gateModule()).scanContent("patches/dependency.patch", content).some(({ rule }) => rule === "password-assignment"),
    mutation: textRules(content).includes("password_assignment"),
  });

  it.each([
    ["literal after a braced reference", `password=\${EMPTY}"${literal}"`],
    ["literal after a $VAR reference", `password=$VAR"${literal}"`],
    ["literal before a braced reference", `password=${literal}\${VAR}`],
    ["literal after a command substitution", `password=$(cat pw)${literal}`],
    ["literal default of an unset reference", `password=\${PW:-${literal}}`],
    ["quoted literal default of an unset reference", `password=\${PW:-"${literal}"}`],
    ["assigned default of an unset reference", `password=\${PW:=${literal}}`],
    ["literal after an angle placeholder", `password=<x>${literal}`],
    ["quoted key, literal after a braced reference", `"password": "\${EMPTY}${literal}"`],
    ["quoted key, literal after a $VAR reference", `"password": "$VAR${literal}"`],
    ["quoted key, literal before a braced reference", `"password": "${literal}\${VAR}"`],
    ["single-quoted key, literal after a braced reference", `'password': '\${EMPTY}${literal}'`],
    ["double-quoted value, literal after a braced reference", `password="\${EMPTY}${literal}"`],
    ["single-quoted value, literal after a braced reference", `password: '\${EMPTY}${literal}'`],
    ["nested array, literal after a braced reference", `{"password": ["\${EMPTY}${literal}"]}`],
    ["element, literal after a braced reference", `<password>\${X}${literal}</password>`],
    ["escaped quoted value, literal after a braced reference", ['{"pass', 'word": "\\u0024{EMPTY}', literal, '"}'].join("")],
    ["literal after a quoted reference", `password="\${EMPTY}"${literal}`],
    ["literal split over two quoted pieces", `password=\${EMPTY}"four""more1234"`],
    ["literal default of a nested reference", `password=\${PW:-\${FALLBACK:-${literal}}}`],
    ["alternate word of a reference", `password=\${PW:+${literal}}`],
    ["element whose literal holds an apostrophe", ["<pass", "word>abc'defg</pass", "word>"].join("")],
    ["element, literal after an angle placeholder", `<password><x>${literal}</password>`],
    ["element, literal inside markup", `<password><b>${literal}</b></password>`],
    ["prefixed key, literal after a spaced command substitution", `{"admin-password": "$(op read pw)${literal}"}`],
    // An unquoted key whose escaped value also matches as written is the flat rule's finding.
    ["unquoted key, escaped value that also matches as written", ["pass", "word: \"abcdefghij\\\"x\""].join("")],
    // Decoded quotes are data, never delimiters: these spell exactly eight characters.
    ["escaped value whose only escape is a quote", ["{\"pass", "word\": \"ab\\\"cdefg\"}"].join("")],
    ["escaped value with a quote after three characters", ["{\"pass", "word\": \"abc\\\"defg\"}"].join("")],
  ])("refuses a %s in both consumers", async (_label, content) => {
    expect(await bothConsumers(content)).toEqual({ gate: true, mutation: true });
  });

  it.each([
    ["bare braced reference", "password=${BUILD_PASSWORD}"],
    ["bare command substitution", "password=$(op read pw)"],
    ["bare angle placeholder", "password=<placeholder>"],
    ["spaced angle placeholder", "password: <your password>"],
    ["empty fallback", ["password", "=", "config.auth.password || ''"].join(" ")],
    ["empty default", "password=${BUILD_PASSWORD:-}"],
    ["quoted empty default", 'password=${BUILD_PASSWORD:-""}'],
    ["required-variable message", "password=${BUILD_PASSWORD:?must be set}"],
    ["two references", "password=${PREFIX}${SUFFIX}"],
    ["quoted bare reference", 'password="${BUILD_PASSWORD}"'],
    ["quoted key with a bare reference", '"password": "${BUILD_PASSWORD}"'],
    ["quoted key with two references", '"password": "${PREFIX}${SUFFIX}"'],
    ["quoted key with an angle placeholder", '"password": "<your password>"'],
    ["element with a bare reference", "<password>${X}</password>"],
    ["element with a command substitution", "<password>$(cat pw)</password>"],
    ["short literal after a reference", 'password=${EMPTY}"short"'],
    ["string literal closed after a placeholder", '{ body: "password=<private-value>", attributes: { type: "integer" } }'],
    ["spaced code after a reference", "const message = 'password=${secret}' + ' was rotated';"],
    ["nested reference default", '{"password": "${PRIMARY:-${SECONDARY}}"}'],
    ["unquoted nested reference default", "password=${PRIMARY:-${SECONDARY}}"],
    ["quoted nested command substitution", '{"password": "$(op read $(cat name))"}'],
    ["unquoted nested command substitution", "password=$(op read $(cat name))"],
    ["element with markup around a reference", "<password><b>${X}</b></password>"],
    ["quoted command substitution with a quoted delimiter", ["pass", "word=\"$(printf ')", "abcdefgh", "')\""].join("")],
    ["command substitution with a quoted delimiter", ["pass", "word=$(printf ')", "abcdefgh", "')"].join("")],
    ["command substitution with an escaped double quote", 'password=$(printf "a\\")b")'],
    ["required-variable message with a quoted brace", ["pass", "word=${PW:?'}", "abcdefgh", "'}"].join("")],
    ["seven literal characters before an over-nested reference", ["pass", "word=\"\"abcdefg", "${A:-${B:-${C}}}"].join("")],
    ["default word that is a double-quoted reference", ["pass", "word=${PW:-\"${FALLBACK}\"}"].join("")],
    ["quoted key, command substitution holding a decoded quote", ["{\"pass", "word\": \"$(printf \\\"x')", "abcdefgh", "\\\")\"}"].join("")],
    ["command substitution holding an escaped closing parenthesis", ["pass", "word=$(printf \\)", "abcdefgh)"].join("")],
    // A prefixed unquoted key judges its escaped value compactly, so decoded prose stays clean.
    ["prefixed unquoted key with an escaped value holding whitespace", ["reset-pass", "word: \"ab\\\"cd efghij\""].join("")],
  ])("allows a %s in both consumers", async (_label, content) => {
    expect(await bothConsumers(content)).toEqual({ gate: false, mutation: false });
  });

  it("measures the literal a value spells once references expand to nothing", () => {
    expect(literalAfterReferences(`\${EMPTY}"${literal}"`)).toBe(literal);
    expect(literalAfterReferences(`$VAR'${literal}'`)).toBe(`$VAR${literal}`);
    expect(literalAfterReferences(`"ab'cd"`)).toBe("ab'cd");
    expect(literalAfterReferences(`\${PW:-"x"}<y>$(z)\${Q?no}`)).toBe("x");
    expect(literalAfterReferences(`"unterminated`)).toBe("unterminated");
    expect(literalAfterReferences("")).toBe("");
  });

  it("expands nested references in one pass and keeps unclosed ones literal", () => {
    expect(expandRuntimeReferences("${A:-${B:-x}}y")).toBe("xy");
    expect(expandRuntimeReferences("${A:-${B}}")).toBe("");
    expect(expandRuntimeReferences("$(a $(b) ${C:-d})e")).toBe("e");
    expect(expandRuntimeReferences("${A:=v}${B=w}${C-x}${D:+y}${E#z}")).toBe("vwxy");
    expect(expandRuntimeReferences("${unclosed")).toBe("${unclosed");
    expect(expandRuntimeReferences("$(a ${B:-c}")).toBe("$(a ${B:-c}");
    expect(expandRuntimeReferences("a<b>c<d<e>f")).toBe("ac<df");
    expect(expandRuntimeReferences("x<y")).toBe("x<y");
    expect(expandRuntimeReferences("abc'def")).toBe("abc'def");
    expect(expandRuntimeReferences("}$)$")).toBe("}$)$");
    // Quoted text inside a reference never closes it; a default word loses its quote delimiters, as in the shell.
    expect(expandRuntimeReferences("$(printf ')x')y")).toBe("y");
    expect(expandRuntimeReferences('$(printf "a\\")b")y')).toBe("y");
    expect(expandRuntimeReferences("${A:?'}'}y")).toBe("y");
    expect(expandRuntimeReferences('${PW:-"x"}')).toBe("x");
    expect(expandRuntimeReferences("$(printf 'open")).toBe("$(printf 'open");
    expect(expandRuntimeReferences('$(printf "a\\')).toBe('$(printf "a\\');
    // A default word keeps its quoted text without the delimiters; double quotes still expand references.
    expect(expandRuntimeReferences("${PW:-'}'}x")).toBe("}x");
    expect(expandRuntimeReferences('${PW:-"${FALLBACK}"}')).toBe("");
    expect(expandRuntimeReferences("${PW:-'${X}'}")).toBe("${X}");
    // Double quotes inside a reference still open a nested command substitution; a plain `$` there is text.
    expect(expandRuntimeReferences('$(a "$(b)" c)y')).toBe("y");
    expect(expandRuntimeReferences('$(echo "$x")y')).toBe("y");
    expect(expandRuntimeReferences("x${")).toBe("x${");
    // A backslash escapes the next character outside quotes and in double quotes, never in single quotes.
    expect(expandRuntimeReferences("$(printf \\)x)y")).toBe("y");
    expect(expandRuntimeReferences("${PW:-a\\}b}")).toBe("a}b");
    expect(expandRuntimeReferences("$(printf '\\')y")).toBe("y");
    expect(expandRuntimeReferences("$(printf \\")).toBe("$(printf \\");
    const started = performance.now();
    expandRuntimeReferences("${A:-".repeat(50_000));
    expandRuntimeReferences("<a".repeat(100_000));
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("reads key shapes and structured values only for key-named rules", () => {
    const passwordRule = ruleNamed("password_assignment");
    const credentialKey = ruleNamed("credential_key_assignment");
    expect(structuredKeyShape(passwordRule, "password")).toBe("exact");
    expect(structuredKeyShape(passwordRule, "admin-password")).toBe("prefixed");
    expect(structuredKeyShape(passwordRule, "password_policy")).toBeUndefined();
    expect(structuredKeyShape(credentialKey, "db_password")).toBe("exact");
    expect(structuredKeyShape(passwordRule, `${"x".repeat(80)} password`)).toBeUndefined();
    // A key inside the name that does not end it (`password: note`) is not the name's key.
    expect(structuredKeyShape(passwordRule, "password: note")).toBeUndefined();
    expect(acceptsStructuredValue(passwordRule, "correct horse battery", false)).toBe(true);
    expect(acceptsStructuredValue(passwordRule, "correct horse battery", true)).toBe(false);
    const tokenFormat = ruleNamed("github_token");
    expect(structuredKeyShape(tokenFormat, "token")).toBeUndefined();
    expect(acceptsStructuredValue(tokenFormat, literal, false)).toBe(false);
  });

  it("blocks a concatenated literal through the CLI guard and redacts it", () => {
    const content = `password=\${EMPTY}"${literal}"`;
    expect(() => evaluateMutationGuard({ author: "agent", payload: { description: content }, settings: blockSettings }))
      .toThrow(/Mutation blocked by secret guard \(password_assignment\)/);
    expect(JSON.stringify(scanMutationSecrets({ description: content }))).not.toContain(literal);
  });

  it("scans element bodies far longer than a repeated regex group could hold", () => {
    const rule = ruleNamed("password_assignment");
    const [open, close] = [["<pass", "word>"].join(""), ["</pass", "word>"].join("")];
    // A repeated per-character group overflowed the V8 backtrack stack near 16 million characters.
    expect([...findSecretRuleMatches(rule, `${open}${"x".repeat(20_000_000)}${close}`)]).toHaveLength(1);
    expect([...findSecretRuleMatches(rule, `${open}${"<x>".repeat(2_000_000)}${close}`)]).toEqual([]);
    expect([...findSecretRuleMatches(rule, `${open}${"<x>".repeat(2_000_000)}${literal}${close}`)]).toHaveLength(1);
    // A tag of the same keys inside the body, or a `<` that never closes, ends nothing.
    expect([...findSecretRuleMatches(rule, `${open}a${open}${literal}${close}`)]).toHaveLength(1);
    expect([...findSecretRuleMatches(rule, `${open}a < b and more text${close}`)]).toEqual([]);
    expect([...findSecretRuleMatches(rule, `${open}${literal}`)]).toEqual([]);
  });

  it("judges element content by its literal for a rule without its own literal minimum", () => {
    const rule: SecretRule = {
      name: "element-probe", mutationRule: "element_probe", regex: /(?!)/g,
      structured: { keys: "probe", value: String.raw`("[^"]*")`, element: true },
    };
    expect([...findSecretRuleMatches(rule, `<probe>\${X}${literal}</probe>`)]).toHaveLength(1);
    expect([...findSecretRuleMatches(rule, "<probe>${X}</probe>")]).toEqual([]);
    expect([...findSecretRuleMatches(rule, "<probe>short</probe>")]).toEqual([]);
  });

  it("keeps pathological reference runs linear", () => {
    const rule = ruleNamed("password_assignment");
    // Spelled at runtime so the repository scan never reads the fixtures as assignments.
    const assign = ["pass", "word="].join("");
    const inputs = [
      `${assign}${"${".repeat(100_000)}`,
      `${assign}${"$(".repeat(100_000)}`,
      `${assign}${"<".repeat(200_000)}`,
      `${assign}$${"{a".repeat(100_000)}`,
      // A value reads at most four quoted pieces, so no scan reaches far past its key.
      '"password"=a"x"'.repeat(40_000),
      `${assign}a${'"'.repeat(200_000)}`,
      `${assign}\${${"a".repeat(400_000)}`,
      `${assign}${"${A:-".repeat(50_000)}`,
      `${assign}${"$(a".repeat(100_000)}`,
      `<password>${"<x>".repeat(100_000)}`,
    ];
    const started = performance.now();
    const counts = inputs.map((input) => Array.from(findSecretRuleMatches(rule, input)).length);
    expect(performance.now() - started).toBeLessThan(5_000);
    // Every key of the repeated input reads `a"x""password"=...` as one concatenated literal.
    expect(counts).toEqual([0, 0, 0, 0, 39_999, 0, 0, 0, 0, 0]);
  });
});

describe("structured payload members are judged under their property names (pm-3fbj1f)", () => {
  const memberFindings = (payload: unknown) => scanMutationSecrets(payload);

  it.each([
    [{ api_key: credential }, "credential_key_assignment", "$.api_key"],
    [{ client_secret: credential }, "credential_key_assignment", "$.client_secret"],
    [{ token: credential }, "credential_key_assignment", "$.token"],
    [{ DB_PASSWORD: credential }, "credential_key_assignment", "$.DB_PASSWORD"],
    [{ secret_key: credential }, "credential_key_assignment", "$.secret_key"],
    [{ "reset-token": credential }, "credential_key_assignment", "$.reset-token"],
    [{ accessToken: credential }, "credential_key_assignment", "$.accessToken"],
    [{ clientSecret: credential }, "credential_key_assignment", "$.clientSecret"],
    [{ HTTPToken: credential }, "credential_key_assignment", "$.HTTPToken"],
    [{ newPassword: pw }, "credential_key_assignment", "$.newPassword"],
    [{ password: pw }, "password_assignment", "$.password"],
    [{ passphrase: `correct horse ${pw}` }, "password_assignment", "$.passphrase"],
    [{ password: [pw] }, "password_assignment", "$.password[0]"],
    [{ password: { value: pw } }, "password_assignment", "$.password.value"],
    [{ password: `\${EMPTY}${pw}` }, "password_assignment", "$.password"],
    [{ options: { auth: { token: credential } } }, "credential_key_assignment", "$.options.auth.token"],
    [{ list: [{ api_key: credential }] }, "credential_key_assignment", "$.list[0].api_key"],
    [{ token: ["aB3dE5fG7hJ9k", "L1mN3pQ5rS7tU9vW"].join("") }, "high_entropy_assignment", "$.token"],
  ] as const)("flags %j as %s at %s", (payload, rule, path) => {
    expect(memberFindings(payload)).toContainEqual({ rule, path });
  });

  it("reports the rule id and member path, never the value", () => {
    const findings = memberFindings({ fields: { api_key: credential } });
    expect(findings).toEqual([{ rule: "credential_key_assignment", path: "$.fields.api_key" }]);
    expect(JSON.stringify(findings)).not.toContain(credential);
  });

  it("reads each object once per scan, so a getter that throws on a later read cannot discard findings", () => {
    const npm = ["np", "m_", "a".repeat(24)].join("");
    let reads = 0;
    const payload: Record<string, unknown> = { description: npm };
    Object.defineProperty(payload, "flaky", {
      enumerable: true,
      get() {
        reads += 1;
        if (reads > 1) throw new Error("second read refused");
        return { note: "short" };
      },
    });
    expect(() => evaluateMutationGuard({ author: "agent", payload, settings: blockSettings }))
      .toThrow(/Mutation blocked by secret guard \(npm_token\)/);
    expect(reads).toBe(1);
  });

  it("measures a default word without its quote delimiters", () => {
    // A data quote and a backslash the shell keeps still count, as text and as a member.
    for (const word of [["abc'", "defg"].join(""), ["abcd\\", "efg"].join("")]) {
      const value = ["${PW:-\"", word, "\"}"].join("");
      expect(textRules(["pass", "word=", value].join("")), value).toContain("password_assignment");
      expect(memberFindings({ password: value }), value).toContainEqual({ rule: "password_assignment", path: "$.password" });
    }
    expect(literalAfterReferences(["${PW:-\"", "abc'defg", "\"}"].join(""))).toBe("abc'defg");
    expect(expandRuntimeReferences(["${PW:-\"", "a\\$b", "\"}"].join(""))).toBe("a$b");
    // Six characters inside the delimiters stay clean; eight are reported, for both quote kinds.
    const eight = ["abcd", "efgh"].join("");
    for (const [open, close] of [["\"", "\""], ["'", "'"]]) {
      expect(textRules(["pass", "word=${PW:-", open, "abcdef", close, "}"].join(""))).toEqual([]);
      expect(memberFindings({ password: ["${PW:-", open, "abcdef", close, "}"].join("") })).toEqual([]);
      expect(memberFindings({ password: ["${PW:-", open, eight, close, "}"].join("") }))
        .toContainEqual({ rule: "password_assignment", path: "$.password" });
    }
  });

  it("judges a payload string holding U+2028 or U+2029 like one holding a line feed", () => {
    for (const separator of ["\n", " ", " "]) {
      const value = ["Synth", separator, "eticOnly1"].join("");
      expect(memberFindings({ password: value }), JSON.stringify(separator)).toContainEqual({ rule: "password_assignment", path: "$.password" });
      // A prefixed key's compact judgment treats each separator as whitespace.
      expect(memberFindings({ "admin-password": value }), JSON.stringify(separator)).toEqual([]);
    }
  });

  it("counts a structured password's quote characters as data", () => {
    // Eight characters each; JSON.stringify escapes the quote, and the decoded quote is data.
    for (const value of [["ab", "\"cdefg"].join(""), ["abc", "\"defg"].join(""), ["a'b", "\"cdefg"].join("").slice(0, 8)]) {
      expect(memberFindings({ password: value }), value).toContainEqual({ rule: "password_assignment", path: "$.password" });
    }
    expect(memberFindings({ password: ["ab", "\"cdef"].join("") })).toEqual([]);
  });

  it("reports a rule once per path when the leaf text and its key both match", () => {
    // The leaf's own text and its credential-named key both yield credential_key_assignment here.
    expect(memberFindings({ api_key: `api_key=${credential}` }).filter(({ rule }) => rule === "credential_key_assignment"))
      .toEqual([{ rule: "credential_key_assignment", path: "$.api_key" }]);
  });

  it("blocks a structured credential through the guard the CLI and MCP adapters use", () => {
    expect(() => evaluateMutationGuard({
      author: "agent", payload: { options: { client_secret: credential } }, settings: blockSettings,
    })).toThrow(/Mutation blocked by secret guard \(credential_key_assignment\)/);
  });

  // The pm-gh1704 must-allow corpus, as object payloads. Each entry is judged
  // exactly like its JSON spelling, so a value that is clean only as unquoted
  // code (a call, an optional chain, a statement constant) is a string
  // literal here, as it already is in `{"token":"getToken(options)"}`.
  it.each([
    { token_budget: "800" }, { max_tokens: "4096" }, { output_token_budget: "3000" }, { token_count: "12" },
    { tokens: "3" }, { api_key: "${API_KEY}" }, { token: "<your token>" }, { secret: "[scrubbed]" },
    { token: "the token expires after 5 minutes" }, { "Secret question": "Pick one" }, { token: "********" },
    { secret: "xxxxxxxxxxxx" }, { token: "required" }, { token: "process.env.GITHUB_TOKEN" },
    { token: "$GITHUB_TOKEN" }, { api_key: "%API_KEY%" }, { pwd: "/usr/local/bin" }, { token: "./build/output" },
    { client_secret: "Configure this in the settings page" }, { token: "authentication failed" },
    { client_secret: "not-configured in this environment" }, { token: "https://example.com/oauth/callback" },
    { token: "options?.token ?? fallback" }, { private_key: "keys/id_ed25519" }, { private_key: ".ssh/id_rsa" },
    { api_key: "not-yet-provisioned" }, { private_key: "certs/client.key" },
    { private_key: "C:/ProgramData/keys/client.pem" }, { api_key: "https://vault.example/v1/secret" },
    { password: "${BUILD_PASSWORD}" }, { password: "$(op read pw)" }, { password: "<your-password>" }, { password: "" },
    { "reset-password": "Reset password" }, { "New password": "Enter a new password" },
  ])("keeps %j clean", (payload) => {
    expect(memberFindings(payload)).toEqual([]);
  });

  it.each([
    [{ token_budget: 800, max_tokens: 4096, estimated_minutes: 30 }],
    [{ options: { tokenBudget: "800", secretGuard: "advise", upsertKey: credential, idempotency_key: credential } }],
    [{ password: Number("12345678"), token: null, secret: true }],
    [{ title: "token: required", description: "Rotate the token after the release." }],
  ])("keeps pm's own numeric, budget and routing fields clean: %j", (payload) => {
    expect(memberFindings(payload)).toEqual([]);
  });

  it("gives a member the verdict of its JSON spelling", () => {
    for (const payload of [
      { token: "getToken(options)" }, { token: "DEFAULT_TOKEN" }, { api_key: credential }, { token: "required" },
      { password: ["short"] }, { password: { type: "str" } }, { "admin-password": pw },
    ]) {
      const [name, value] = Object.entries(payload)[0]!;
      const spelled = textRules(JSON.stringify({ [name]: value }));
      expect(memberFindings(payload).map(({ rule }) => rule), JSON.stringify(payload)).toEqual(spelled);
    }
  });

  it("judges values that hold BigInts or repeated objects without failing open", () => {
    expect(memberFindings({ api_key: 10n, token: [10n] })).toEqual([]);
    const shared = { note: "short" };
    const cyclic: Record<string, unknown> = { secret: credential };
    cyclic.self = cyclic;
    expect(memberFindings({ token: { count: 10n, value: credential } }))
      .toContainEqual({ rule: "credential_key_assignment", path: "$.token.value" });
    expect(memberFindings({ password: { first: shared, second: shared } })).toEqual([]);
    expect(memberFindings({ password: { first: shared, second: shared, value: pw } }))
      .toContainEqual({ rule: "password_assignment", path: "$.password.value" });
    expect(memberFindings({ wrapper: cyclic })).toContainEqual({ rule: "credential_key_assignment", path: "$.wrapper.secret" });
    const loop: Record<string, unknown> = {};
    loop.token = loop;
    expect(memberFindings(loop)).toEqual([]);
  });

  it("expands references in a member value with its decoded quote characters", () => {
    // The value is one command reference whose own double quotes hold `x')...`.
    const command = ["$(printf \"x')", "abcdefgh", "\")"].join("");
    expect(memberFindings({ password: command })).toEqual([]);
    expect(memberFindings({ password: `${command}${literal}` })).toContainEqual({ rule: "password_assignment", path: "$.password" });
  });

  it("reads arrays through their index keys, never through payload-owned methods", () => {
    const npm = ["np", "m_", "a".repeat(24)].join("");
    for (const method of ["forEach", "map", "flatMap", "filter", "keys", "entries", Symbol.iterator]) {
      const hostile = Object.assign([npm], { [method]: null });
      expect(() => evaluateMutationGuard({ author: "agent", payload: { extra: hostile }, settings: blockSettings }), String(method))
        .toThrow(/Mutation blocked by secret guard \(npm_token\)/);
    }
    const sparse: unknown[] = [];
    sparse.length = 2 ** 32 - 1;
    sparse[7] = npm;
    const started = performance.now();
    expect(memberFindings({ sparse })).toEqual([{ rule: "npm_token", path: "$.sparse[7]" }]);
    expect(performance.now() - started).toBeLessThan(1_000);
    // A non-enumerable element is still an element, as a length-based walk and JSON.stringify read it.
    const hidden: unknown[] = [];
    Object.defineProperty(hidden, "0", { value: npm, enumerable: false });
    expect(memberFindings({ hidden })).toEqual([{ rule: "npm_token", path: "$.hidden[0]" }]);
    // 2^32 - 1 is not an array index, so that property is not an element.
    const outOfRange = Object.assign([] as unknown[], { [String(2 ** 32 - 1)]: npm });
    expect(memberFindings({ outOfRange })).toEqual([]);
    const withProperty = Object.assign([npm], { label: npm });
    expect(memberFindings({ withProperty }).map(({ path }) => path)).toEqual(["$.withProperty[0]"]);
  });

  it("keeps blocking when another member holds a boxed BigInt or a throwing toJSON", () => {
    const hostile = { toJSON(): never { throw new Error("serialization refused"); } };
    for (const neighbor of [Object(1n), hostile, new Date(0), Object("text")]) {
      expect(() => evaluateMutationGuard({
        author: "agent", payload: { api_key: credential, token: neighbor }, settings: blockSettings,
      })).toThrow(/Mutation blocked by secret guard \(credential_key_assignment\)/);
    }
  });

  it("judges a shared object again under a credential key it was first seen without", () => {
    const shared = { note: credential };
    expect(memberFindings({ plain: shared, token: shared })).toContainEqual({ rule: "credential_key_assignment", path: "$.token.note" });
    expect(memberFindings({ token: shared, plain: shared })).toContainEqual({ rule: "credential_key_assignment", path: "$.token.note" });
  });

  it("keeps a compound credential key under a camelCase prefix", () => {
    for (const name of ["dbPassPhrase", "clientAPIkey", "awsSecretAccessKey", "myServiceDBPassword", "aBcDeFgHiJkLmNoPqRsTuVwXyZToken"]) {
      expect(memberFindings({ [name]: credential }), name).toContainEqual({ rule: "credential_key_assignment", path: `$.${name}` });
    }
    expect(memberFindings({ tokenBudgetMaxTokens: credential, secretGuardMode: credential })).toEqual([]);
  });

  it("scans only object members, so a top-level string or scalar has no member findings", () => {
    expect(memberFindings(["pass", "word=", literal].join(""))).toEqual([{ rule: "password_assignment", path: "$" }]);
    expect(memberFindings(42)).toEqual([]);
    expect(memberFindings(null)).toEqual([]);
    expect(memberFindings([credential])).toEqual([]);
  });

  it("keeps a recognized key when camelCase splitting would break it", () => {
    expect(memberFindings({ passPhrase: pw })).toContainEqual({ rule: "password_assignment", path: "$.passPhrase" });
    expect(memberFindings({ APIkey: credential })).toContainEqual({ rule: "credential_key_assignment", path: "$.APIkey" });
  });

  it("applies every credential key above a leaf, as the JSON spelling does", () => {
    const words = `correct horse ${pw}`;
    // An exact outer key judges array elements leniently, even under a prefixed inner key.
    expect(memberFindings({ password: { "admin-password": [words] } }))
      .toContainEqual({ rule: "password_assignment", path: "$.password.admin-password[0]" });
    // A prefixed key alone keeps whitespace-bearing prose clean.
    expect(memberFindings({ "admin-password": [words] })).toEqual([]);
    // An object member's value is compact under any key, so prose stays clean there.
    expect(memberFindings({ password: { note: words } })).toEqual([]);
    expect(memberFindings({ password: [[words]] })).toContainEqual({ rule: "password_assignment", path: "$.password[0][0]" });
  });

  it("reports the rules of the JSON spelling for every nested payload shape", () => {
    // Every container shape up to three levels over a grid of keys and values,
    // with exactly one string leaf per payload, so each comparison judges one
    // leaf. Keys stay in spellings text can carry (camelCase splitting is a
    // payload-only reading).
    const keys = ["password", "admin-password", "token", "reset-token", "api_key", "DB_PASSWORD", "note", "token_budget"];
    const values = [credential, pw, `correct horse ${pw}`, "short", "${BUILD_PASSWORD}",
      `\${EMPTY}${pw}`, ["aB3dE5fG7hJ9k", "L1mN3pQ5rS7tU9vW"].join(""), "required"];
    const shapes: Array<(leaf: string, inner: string, innermost: string) => unknown> = [
      (leaf) => leaf,
      (leaf) => [leaf],
      (leaf) => [[leaf]],
      (leaf, inner) => ({ [inner]: leaf }),
      (leaf, inner) => [{ [inner]: leaf }],
      (leaf, inner) => ({ [inner]: [leaf] }),
      (leaf, inner) => ({ [inner]: 800, other: [7, [leaf], []] }),
      (leaf, inner, innermost) => ({ [inner]: { [innermost]: leaf } }),
      (leaf, inner, innermost) => ({ [inner]: [{ [innermost]: leaf }] }),
    ];
    const ruleSet = (rules: readonly string[]) => [...new Set(rules)].sort();
    // A shape's arity says how many nested keys it takes; unused key slots stay fixed.
    const keySlots = (arity: number) => (arity > 1 ? keys : [keys[0]!]);
    const payloads = shapes.flatMap((shape) => keys.flatMap((outer) => keySlots(shape.length).flatMap((inner) =>
      keySlots(shape.length - 1).flatMap((innermost) => values.map((leaf) => ({ [outer]: shape(leaf, inner, innermost) }))))));
    let flagged = 0;
    for (const payload of payloads) {
      const members = ruleSet(memberFindings(payload).map(({ rule }) => rule));
      expect(members, JSON.stringify(payload)).toEqual(ruleSet(textRules(JSON.stringify(payload))));
      if (members.length > 0) flagged += 1;
    }
    const compared = payloads.length;
    expect(compared).toBe(8 * 8 * (3 + 4 * 8 + 2 * 64));
    // The grid must exercise both verdicts.
    expect(flagged).toBeGreaterThan(compared / 10);
    expect(flagged).toBeLessThan(compared);
  });

  it("scans a payload nested far deeper than the call stack and blocks its credential (pm-wq9njf)", () => {
    let leafOnly: unknown = { note: ["np", "m_", "a".repeat(24)].join("") };
    let keyed: Record<string, unknown> = { note: credential };
    for (let depth = 0; depth < 100_000; depth += 1) {
      leafOnly = [leafOnly];
      keyed = { token: keyed };
    }
    expect(memberFindings(leafOnly).map(({ rule }) => rule)).toContain("npm_token");
    expect(memberFindings(keyed).map(({ rule }) => rule)).toEqual(["credential_key_assignment"]);
    expect(() => evaluateMutationGuard({ author: "agent", payload: keyed, settings: blockSettings }))
      .toThrow(/Mutation blocked by secret guard \(credential_key_assignment\)/);
  });

  it("keeps depth-first finding order across siblings and nesting", () => {
    const npm = ["np", "m_", "a".repeat(24)].join("");
    expect(memberFindings({ first: { inner: npm }, second: npm, third: [npm, { deep: npm }] }).map(({ path }) => path))
      .toEqual(["$.first.inner", "$.second", "$.third[0]", "$.third[1].deep"]);
  });

  it("scans a deep chain of credential-named members in linear time", () => {
    let clean: Record<string, unknown> = { note: "short" };
    let flagged: Record<string, unknown> = { note: credential };
    for (let depth = 0; depth < 1_000; depth += 1) {
      clean = { token: clean };
      flagged = { token: flagged };
    }
    const started = performance.now();
    expect(memberFindings(clean)).toEqual([]);
    expect(memberFindings(flagged)).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("does not report a credential found inside a member's value as the member's own", () => {
    // The prefixed key's compact walk keeps the prose member clean; the
    // assignment inside it belongs to the nested leaf, not to the container.
    expect(memberFindings({ "admin-password": { note: `see password=${pw} here` } })).toEqual([
      { rule: "password_assignment", path: "$.admin-password.note" },
    ]);
    expect(memberFindings({ token: `<password>${pw}</password>` })).toEqual([
      { rule: "password_assignment", path: "$.token" },
    ]);
  });
});
