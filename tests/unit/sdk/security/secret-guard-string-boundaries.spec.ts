/**
 * Regression coverage for GH-1775 (pm-gh1775): a value made only of a
 * run-time reference is never a credential under any credential key, in
 * serialized JSON text as everywhere else. The closing quote of the string a
 * value sits in, the JSON structure after it and the next string are a string
 * boundary, never a quoted piece concatenated to the value, while a reference
 * with an attached literal and a literal value are still flagged.
 */
import { describe, expect, it } from "vitest";
import { scanMutationSecrets } from "../../../../src/sdk/mutation-guard.js";
import { expandRuntimeReferences, literalAfterReferences } from "../../../../src/core/shared/secret-rules.js";

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
    // Structure followed by a word is not a next member, so the word may continue.
    expect(rulesOf(`${passwordKey}: ${D}API_KEY",word`)).toEqual(["password_assignment"]);
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

  it("reads a structure run as a quoted piece when no closed string follows it", () => {
    // The same bytes as the reproduction's boundary, but the next string never
    // closes, so nothing marks the enclosing string: the run is concatenated.
    expect(rulesOf(`api_key=${D}{EMPTY}","${literal}`)).toEqual(["credential_key_assignment"]);
    expect(rulesOf(`${passwordKey}=${D}PW","${literal}`)).toEqual(["password_assignment"]);
    // A run longer than the bound is read as a piece too, so the guard fails closed.
    expect(rulesOf(`${passwordKey}=${D}{PW}"${",".repeat(65)}"${literal}"`)).toEqual(["password_assignment"]);
    expect(rulesOf(`${passwordKey}=${D}{PW}"${",".repeat(64)}"${literal}"`)).toEqual([]);
  });

  it("keeps a quote that may open a concatenated piece as part of the word", () => {
    // An empty quoted piece or a spaced word after a dollar name may continue a
    // shell word, so its text stays literal and the eight characters are judged.
    expect(rulesOf(`${passwordKey}=${D}API_KEY""${literal}`)).toEqual(["password_assignment"]);
    expect(rulesOf(`${passwordKey}: ${D}API_KEY" spaced literal"`)).toEqual(["password_assignment"]);
  });
});

describe("a whole-value Windows variable is a reference for every key-named rule (GH-1775)", () => {
  it("expands a bare or quoted whole-value percent name to nothing", () => {
    expect(literalAfterReferences("%DB_PASSWORD%")).toBe("");
    expect(literalAfterReferences("\"%DB_PASSWORD%\"")).toBe("");
    expect(literalAfterReferences("'%app_data%'")).toBe("");
    expect(expandRuntimeReferences("%DB_PASSWORD%")).toBe("");
  });

  it("keeps a percent name that is not the whole value, or not a complete word, as literal text", () => {
    expect(literalAfterReferences(`%DB_PASSWORD%${literal}`)).toBe(`%DB_PASSWORD%${literal}`);
    expect(literalAfterReferences("%DB_PASSWORD%", false)).toBe("%DB_PASSWORD%");
    expect(literalAfterReferences("%1abc%")).toBe("%1abc%");
    expect(rulesOf(`${passwordKey}: %DB_PASSWORD%${literal}`)).toEqual(["password_assignment"]);
  });
});
