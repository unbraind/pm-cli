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

  it("stays linear over many assignments in one long string", () => {
    const text = JSON.stringify({ title: `api_key: ${D}{A} xxxxxxxxxx `.repeat(100_000), updated: "x" });
    const started = performance.now();
    expect(rulesOf(text)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
