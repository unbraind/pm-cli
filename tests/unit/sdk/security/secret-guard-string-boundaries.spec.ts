/**
 * Regression coverage for GH-1775 (pm-gh1775): a value made only of a
 * run-time reference is never a credential under any credential key, in
 * serialized JSON text as everywhere else. A value that sits in a string ends
 * at that string's closing quote, found by a lexical pass over the text, when
 * a word end follows the quote, so the next member is never read as a quoted
 * piece concatenated to the value; a reference with an attached literal and a
 * literal value are still flagged.
 */
import { describe, expect, it } from "vitest";
import { scanMutationSecrets } from "../../../../src/sdk/mutation-guard.js";

// Built at runtime so this file stays clean under the repository secret scan.
const D = "$";
const literal = ["q7Zx9Lm2", "Pw4R"].join("");
const passwordKey = ["pass", "word"].join("");
const keys = ["api_key", "client_secret", "token", "secret", passwordKey, "GITHUB_TOKEN", `db_${passwordKey}`];
const rulesOf = (payload: unknown) => scanMutationSecrets(payload).map(({ rule }) => rule);

/** Every reference spelling the issue names, each spelling no literal. */
const references = [
  ["braced", `${D}{API_KEY}`],
  ["dollar name", `${D}API_KEY`],
  ["workflow expression", `${D}{{ secrets.API_KEY }}`],
  ["command substitution", `${D}(op read item)`],
  ["empty default", `${D}{API_KEY:-}`],
  ["angle placeholder", "<api-key>"],
  ["Windows variable", "%API_KEY%"],
] as const;

/** The spellings a tracker stores configuration in, each with a sibling after the value where the form has one. */
const forms = {
  "JSON text with a sibling member (the GH-1775 reproduction)": (key: string, value: string) =>
    JSON.stringify({ title: `${key}: ${value}`, updated: "2026-11-23T00:00:00.000Z" }),
  "JSON text with an equals assignment": (key: string, value: string) => JSON.stringify({ title: `${key}=${value}`, updated: "x-y-z" }),
  "JSON text array": (key: string, value: string) => JSON.stringify([`${key}=${value}`, "another-string-value"]),
  "nested JSON text": (key: string, value: string) => JSON.stringify({ a: { title: `${key}: ${value}` }, b: { c: "deadbeefcafe" } }),
  "pretty-printed JSON text": (key: string, value: string) => JSON.stringify({ title: `${key}: ${value}`, updated: "x" }, null, 2),
  "JSON text, value in the last member": (key: string, value: string) => JSON.stringify({ a: 1, title: `${key}: ${value}` }),
  "compact Python repr": (key: string, value: string) => `{'title':'${key}: ${value}','updated':'2026-11-23'}`,
  "spaced Python repr": (key: string, value: string) => `{'title': '${key}: ${value}', 'updated': '2026-11-23'}`,
  "quoted-key JSON object": (key: string, value: string) => JSON.stringify({ [key]: value, updated: "2026-11-23" }),
  YAML: (key: string, value: string) => `${key}: ${value}\nother: value`,
  dotenv: (key: string, value: string) => `${key.toUpperCase()}=${value}\nNEXT=1`,
  XML: (key: string, value: string) => `<${key}>${value}</${key}><b>x</b>`,
  "quoted key and value": (key: string, value: string) => `"${key}": "${value}", "updated": "2026-11-23"`,
} as const;

describe("bare references are never credentials (GH-1775)", () => {
  it("passes the exact reproduction from the issue", () => {
    expect(rulesOf(JSON.stringify({ title: `api_key: ${D}{API_KEY}`, updated: "2026-11-23T00:00:00.000Z" }))).toEqual([]);
    expect(rulesOf(`token=${D}GITHUB_TOKEN`)).toEqual([]);
  });

  it.each(Object.entries(forms))("passes every bare reference under every credential key: %s", (_form, spell) => {
    for (const key of keys) {
      for (const [spelling, reference] of references) {
        const text = spell(key, reference);
        expect(rulesOf(text), `${key} / ${spelling}: ${text}`).toEqual([]);
        // The same text as a payload string and as a payload member value reads alike.
        expect(rulesOf({ description: text }), `${key} / ${spelling} (payload)`).toEqual([]);
      }
    }
  });

  it("ends a dollar name's word at the closing quote of the string it sits in", () => {
    // Structure and then a bare JSON scalar, a brace or the end of the text also close the string.
    expect(rulesOf(JSON.stringify([`${passwordKey}: ${D}API_KEY`, 5]))).toEqual([]);
    expect(rulesOf(JSON.stringify([`${passwordKey}: ${D}API_KEY`, true]))).toEqual([]);
    expect(rulesOf(JSON.stringify([{ t: `${passwordKey}: ${D}API_KEY` }, { u: 1 }]))).toEqual([]);
    expect(rulesOf(`"${passwordKey}: ${D}API_KEY"`)).toEqual([]);
    expect(rulesOf(`"${passwordKey}: ${D}API_KEY"   \nnext line`)).toEqual([]);
    // Prose that quotes a whole assignment ends the word at the closing quote and a blank.
    expect(rulesOf(`Use "${passwordKey}: ${D}API_KEY" in the deploy config`)).toEqual([]);
    // Structure followed by a word is not a next member, so the word may continue.
    expect(rulesOf(`"${passwordKey}: ${D}API_KEY",word`)).toEqual(["password_assignment"]);
  });

  it("passes bare references as structured payload members", () => {
    for (const key of keys) {
      for (const [spelling, reference] of references) {
        expect(rulesOf({ config: { [key]: reference }, title: "x" }), `${key} / ${spelling}`).toEqual([]);
      }
    }
  });
});

describe("attached literals and literal values are still credentials (GH-1775 negative control)", () => {
  const flagged = [
    ["literal value", literal],
    ["literal after a braced reference", `${D}{EMPTY}${literal}`],
    ["literal default", `${D}{KEY:-${literal}}`],
  ] as const;

  it.each(Object.entries(forms))("flags every attached literal and literal value: %s", (_form, spell) => {
    for (const key of keys) {
      for (const [spelling, value] of flagged) {
        const text = spell(key, value);
        expect(rulesOf(text).length, `${key} / ${spelling}: ${text}`).toBeGreaterThan(0);
      }
    }
  });

  it("still flags a credential member next to a bare reference in the same JSON text", () => {
    expect(rulesOf(`{"title":"api_key: ${D}{API_KEY}","${passwordKey}":"${literal}"}`)).toEqual(["password_assignment"]);
    expect(rulesOf(`{"title":"token: ${D}{T}","api_key":"${literal}"}`)).toEqual(["credential_key_assignment"]);
    expect(rulesOf(`["api_key=${D}{A}","${passwordKey}=${literal}"]`)).toEqual(["password_assignment"]);
  });

  it("keeps the quoted pieces of a value that sits in no string", () => {
    // The value's own quotes are shell pieces: nothing before it opened a string.
    expect(rulesOf(`api_key=${D}{EMPTY}","${literal}`)).toEqual(["credential_key_assignment"]);
    expect(rulesOf(`${passwordKey}=${D}PW","${literal}`)).toEqual(["password_assignment"]);
    // A YAML single-quoted scalar escapes a quote by doubling it, so `'',''` is data.
    expect(rulesOf(`token: '${D}{EMPTY}'',''${literal}'`)).toEqual(["credential_key_assignment"]);
    expect(rulesOf(`${passwordKey}: '${D}{EMPTY}'',''${literal}'`)).toEqual(["password_assignment"]);
    // A quote no string opened is part of a plain scalar, so the variable stays literal.
    expect(rulesOf(`${passwordKey}: ${D}${literal}"`)).toEqual(["password_assignment"]);
  });

  it("ends a value at a sibling only when its string is a member or element of a container (CodeRabbit)", () => {
    // A string a command word opened is a shell word: `","<literal>` after its closing quote is more of it.
    expect(rulesOf(`echo "api_key=${D}{EMPTY}","${literal}"`)).toEqual(["credential_key_assignment"]);
    expect(rulesOf(`Use "api_key: ${D}{EMPTY}","${literal}" in config`)).toEqual(["credential_key_assignment"]);
    // The same text as a JSON element or member value ends at the string's closing quote.
    expect(rulesOf(`["api_key=${D}{EMPTY}","${literal}"]`)).toEqual([]);
    expect(rulesOf(`{"cmd": "api_key=${D}{EMPTY}", "note": "${literal}"}`)).toEqual([]);
  });

  it("continues the word when another quote or a word follows the closing quote", () => {
    // `"…${EMPTY}""…"` and `"…${EMPTY}"…` concatenate in a shell, so the literal is judged.
    expect(rulesOf(`echo "api_key=${D}{EMPTY}""${literal}"`)).toEqual(["credential_key_assignment"]);
    expect(rulesOf(`echo "${passwordKey}=${D}{EMPTY}""${literal}"`)).toEqual(["password_assignment"]);
    expect(rulesOf(`${passwordKey}=${D}API_KEY""${literal}`)).toEqual(["password_assignment"]);
    // A quote that opens a spaced piece after a value outside every string still continues it.
    expect(rulesOf(`${passwordKey}: ${D}API_KEY" spaced literal"`)).toEqual(["password_assignment"]);
  });

  it("finds the closing quote however long the next member is, and reads JSON whitespace", () => {
    const long = ["v23R4iN7-", "8d09cfea-".repeat(460)].join("");
    expect(rulesOf(JSON.stringify([`api_key: ${D}DB_PASSWORD`, long]))).toEqual([]);
    expect(rulesOf(`{"title":"${passwordKey}: ${D}DB_PASSWORD" , "next":"ok"}`)).toEqual([]);
    // An escaped quote inside the string never closes it.
    expect(rulesOf(`{"title":"say \\"hi\\" api_key: ${D}{EMPTY}${literal}","u":"x"}`)).toEqual(["credential_key_assignment"]);
  });

  it("still scans keys in the members after a value that ends at its string", () => {
    expect(rulesOf(`{"title":"api_key: ${D}{A}","note":"token=${literal}"}`)).toEqual(["credential_key_assignment"]);
  });

  it("never lets a prose apostrophe or unit mark open a string", () => {
    // `customer's` would otherwise open a string that the value's own quote closes.
    expect(rulesOf(`note: the customer's ${passwordKey}='  correct horse battery staple'`)).toEqual(["password_assignment"]);
    expect(rulesOf(`the students' ${passwordKey}='  correct horse battery staple'`)).toEqual(["password_assignment"]);
    expect(rulesOf(`a 5" screen, ${passwordKey}="  correct horse battery staple"`)).toEqual(["password_assignment"]);
  });

  it("keeps a value whose first character the lexical pass reads as a closing quote (Codex round 3)", () => {
    // A YAML flow apostrophe opens a false string; the password's own opening quote is never a cut point.
    expect(rulesOf(`- {note: Unexpected token ' in header, ${passwordKey}: ' correct horse battery staple'}`)).toEqual(["password_assignment"]);
  });

  it("never cuts a value at a quote inside its own quoted text (Codex round 4)", () => {
    // A stray apostrophe opens a false string; the apostrophe inside the real password is data.
    expect(rulesOf(`- {note: Unexpected token ' in header, ${passwordKey}: "devs' portal 2026"}`)).toEqual(["password_assignment"]);
    // A quoted default inside a reference is data of the value, not the outer string's closer.
    expect(rulesOf(`docker run --env "${passwordKey}=${D}{PW:-" correct horse battery staple"}" demo`)).toEqual(["password_assignment"]);
  });

  it("ends a lexical string at a line break, and never escapes one with a backslash", () => {
    // A string that a line break ends never closes, so the variable is judged as the word the blank ends.
    expect(rulesOf(`"${passwordKey}: ${D}API_KEY\nnext"`)).toEqual([]);
    // A backslash before a line break escapes nothing, so the next line starts outside every string.
    expect(rulesOf(`continued \\\n["${passwordKey}: ${D}API_KEY", "x"]`)).toEqual([]);
    expect(rulesOf(`trailing backslash \\`)).toEqual([]);
  });

  it("ends a string at a tag end only when it is an attribute value (Codex round 5)", () => {
    // `>` after a quote inside a real password, or inside a quoted default, never ends the value.
    expect(rulesOf(`- {note: Expected apostrophe ' in the header, ${passwordKey}: "v7'>>cV9uM2a!"}`)).toEqual(["password_assignment"]);
    expect(rulesOf(`"api_key=${D}{PW:-">abcD7!q2"}"`)).toEqual(["credential_key_assignment"]);
    // A percent reference before a JSON escape keeps the reference-free grammar's placeholder reading.
    expect(rulesOf(`{"title":"api_key=%DEPLOY_KEY%\\nmode=prod","updated":"ok"}`)).toEqual([]);
  });

  it("never cuts a value while its own quote of the other kind is open (CodeRabbit round 2)", () => {
    // An apostrophe after `=` opens a false attribute string; the quote inside the password is data.
    expect(rulesOf(`x='y ${passwordKey}: "v7'>cV9uM2a!"`)).toEqual(["password_assignment"]);
    expect(rulesOf(`<a x='y ${passwordKey}: "v7'>cV9uM2a!"/>`)).toEqual(["password_assignment"]);
    // Greptile: an apostrophe inside a placeholder never opens the value's own quote.
    expect(rulesOf(JSON.stringify({ title: `${passwordKey}: <team's-password>`, updated: "ok" }))).toEqual([]);
    // Greptile round 6: a double quote after a plain prefix opens the value's own shell piece.
    expect(rulesOf(`x='y ${passwordKey}: a"b'>${literal}"`)).toEqual(["password_assignment"]);
    // Greptile round 7: a real attribute value still ends at its closing quote before the tag end.
    expect(rulesOf(`<setting value="${passwordKey}=${D}{PW}">"deployment"`)).toEqual([]);
    // A quoted piece the value closes again leaves the enclosing closer free to end the value.
    expect(rulesOf(`{"t":"api_key: ${D}{E}'x'","u":"y"}`)).toEqual([]);
    expect(rulesOf(`{"t":"api_key: ${D}{E}'${literal}'","u":"y"}`)).toEqual(["credential_key_assignment"]);
  });

  it("reads a long sibling scalar or flow key after a closing quote whole (CodeRabbit round 2)", () => {
    expect(rulesOf(`["${passwordKey}: ${D}DB_PASSWORD",${"1".repeat(50)}]`)).toEqual([]);
    expect(rulesOf(`{title: "${passwordKey}: ${D}DB_PASSWORD", ${"a".repeat(60)}: ok}`)).toEqual([]);
    expect(rulesOf(`["${passwordKey}: ${D}DB_PASSWORD",word]`)).toEqual(["password_assignment"]);
  });

  it("reads a JSON member value that starts on the next line", () => {
    expect(rulesOf(`{"title":\n  "${passwordKey}=${D}DB_PASSWORD","other":"ok"}`)).toEqual([]);
    // Greptile: an element after an opening bracket on the previous line is a container element too.
    expect(rulesOf(`[\n  "${passwordKey}: ${D}DB_PASSWORD", "other"]`)).toEqual([]);
  });

  it("reads an XML attribute value whose equals sign blanks surround (Greptile)", () => {
    expect(rulesOf(`<setting value = "${passwordKey}=${D}DB_PASSWORD"/>`)).toEqual([]);
  });

  it("reads JSON line separators, YAML flow keys, XML tag ends and long padding after a closing quote", () => {
    expect(rulesOf(JSON.stringify({ title: `Deploy notes\u2028${passwordKey}: ${D}DB_PASSWORD`, updated: "ok" }))).toEqual([]);
    expect(rulesOf(`{title: "${passwordKey}: ${D}DB_PASSWORD", updated: ok}`)).toEqual([]);
    expect(rulesOf(`<setting value="${passwordKey}=${D}DB_PASSWORD"/>`)).toEqual([]);
    expect(rulesOf(`<setting value="${passwordKey}=${D}DB_PASSWORD">`)).toEqual([]);
    expect(rulesOf(`["${passwordKey}: ${D}DB_PASSWORD",${" ".repeat(80)}"ok"]`)).toEqual([]);
  });

  it("stays linear over many assignments in one long string", () => {
    const text = JSON.stringify({ title: `api_key: ${D}{A} xxxxxxxxxx `.repeat(100_000), updated: "x" });
    const started = performance.now();
    expect(rulesOf(text)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

describe("a whole Windows variable is a placeholder for every key-named rule (GH-1775)", () => {
  it("passes a whole percent reference as a text, quoted, element or payload value", () => {
    for (const text of [
      `${passwordKey}: %DB_PASSWORD%`,
      `${passwordKey.toUpperCase()}=%DB_PASSWORD%\nNEXT=1`,
      `${passwordKey}="%DB_PASSWORD%"`,
      `{"${passwordKey}":"%DB_PASSWORD%"}`,
      `<${passwordKey}>%DB_PASSWORD%</${passwordKey}>`,
      `{"title":"${passwordKey}: %DB_PASSWORD%","updated":"ok"}`,
      "api_key: %API_KEY%",
    ]) {
      expect(rulesOf(text), text).toEqual([]);
    }
    expect(rulesOf({ config: { [passwordKey]: "%DB_PASSWORD%" } })).toEqual([]);
  });

  it("judges a percent reference that more of its line follows, or a literal attached to it", () => {
    // cmd.exe reads `set NAME=value` to the end of the line, so the words after it are part of the value.
    expect(rulesOf(`${passwordKey.toUpperCase()}=%DB_PASSWORD% staging`)).toEqual(["password_assignment"]);
    expect(rulesOf(`${passwordKey}: %DB_PASSWORD%${literal}`)).toEqual(["password_assignment"]);
    expect(rulesOf(`api_key=%API_KEY%${literal}`)).toEqual(["credential_key_assignment"]);
    expect(rulesOf(`{"api_key":"%API_KEY%${literal}"}`)).toEqual(["credential_key_assignment"]);
  });
});
