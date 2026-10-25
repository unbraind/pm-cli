import { describe, expect, it } from "vitest";
import { scanMutationSecrets, evaluateMutationGuard } from "../../../../src/sdk/mutation-guard.js";
import { createScriptHarness } from "../../../helpers/scriptModule.js";

const harness = createScriptHarness();
const unix = ["", "home", "synthetic-user", "project"].join("/");
const mac = ["", "Users", "synthetic-user", "project"].join("/");
const windows = ["C:", "Users", "synthetic-user", "project"].join("\\");
const concrete = [
  ["unix", unix], ["mac", mac], ["root", ["", "root", "project"].join("/")],
  ["single quote", "'" + unix + "'"], ["double quote", '"' + unix + '"'],
  ["angle brackets", "<" + unix + ">"], ["file URL", "file://" + unix],
  ["angle file URL", "<file://" + unix + ">"], ["localhost file URL", "file://localhost" + unix],
  ["percent", encodeURIComponent(unix)], ["lowercase percent", encodeURIComponent(unix).toLowerCase()],
  ["double percent", encodeURIComponent(encodeURIComponent(unix))],
  ["triple percent", encodeURIComponent(encodeURIComponent(encodeURIComponent(unix)))],
  ["percent file URL", "file://" + encodeURIComponent(unix)],
  ["malformed percent prefix", "%zz " + encodeURIComponent(unix)],
  ["invalid UTF8 prefix", "%ff" + encodeURIComponent(unix)],
  ["escaped slashes", unix.replaceAll("/", "\\/")],
  ["UNC", ["", "", "server", "Users", "synthetic-user", "project"].join("\\")],
  ["Windows", windows], ["forward Windows", windows.replaceAll("\\", "/").replace("Users", "users")],
  ["mixed Windows", windows.replace("\\synthetic-user", "/synthetic-user").replace("Users", "uSeRs")],
  ["Windows file URL", "file:///" + windows.replaceAll("\\", "/")],
  ["trailing parenthesis", unix + ")"], ["trailing bracket", unix + "]"],
  ["trailing comma", unix + ","], ["trailing period", unix + "."],
  ["fullwidth", unix.replaceAll("/", "\uff0f").replace("home", "\uff48\uff4f\uff4d\uff45")],
  ["division slash", unix.replaceAll("/", "\u2215")], ["fraction slash", unix.replaceAll("/", "\u2044")],
  ["Cyrillic o", unix.replace("home", "h\u043eme")], ["Cyrillic s", mac.replace("Users", "U\u0455ers")],
  ["zero width", unix.replace("home", "ho\u200bme")], ["bidi control", unix.replace("home", "ho\u202eme")],
  ["emphasis", "**" + unix + "**"], ["assignment", "path=" + unix], ["CLI equals", "--note=" + unix],
  ["URL query", "https://example.test/?path=" + unix], ["symbol prefix", "\u{1f680}" + unix],
  ["bracket file URL", "[file://" + unix + "]"], ["colon", "path:" + unix],
  ["percent fullwidth", encodeURIComponent(unix.replaceAll("/", "\uff0f"))],
  ["malformed adjacent prefix", "%zz" + encodeURIComponent(unix)],
  ["JSON Unicode escapes", unix.replaceAll("/", "\\u002f").replace("home", "h\\u006fme")],
  ["script byte escapes", unix.replaceAll("/", "\\x2f")],
  ["uppercase confusables", mac.replace("Users", "U\u0405ERS")],
  ["Arabic bidi mark", unix.replace("home", "ho\u061cme")],
  ["percent Arabic bidi mark", unix.replace("home", "ho%D8%9Cme")],
  ["serialized Arabic bidi mark", unix.replace("home", "ho\\u061Cme")],
  ["repeated POSIX separators", ["", "home", "", "", "synthetic-user", "project"].join("/")],
  ["multiple root separators", "//" + unix],
  ["Windows rooted profile", ["", "Users", "synthetic-user", "project"].join("\\")],
  ["backslash file URL", "file:" + "\\".repeat(3) + windows],
  ["mixed file URL", "file:/" + windows],
  ["drive authority file URL", "file://" + windows.replaceAll("\\", "/")],
  ["remote file URL", "file://server" + mac],
  ["UNC shared profile", ["", "", "server", "share", "Users", "synthetic-user", "project"].join("\\")],
  ["UNC shared drive", ["", "", "server", "C$", "Users", "synthetic-user", "project"].join("\\")],
  ["shared file URL", "file://server/share" + mac],
  ["shared drive file URL", "file://server/C$" + mac],
  ["UNC share with spaces", ["", "", "server", "Team Share", "Users", "synthetic-user", "project"].join("\\")],
  ["file URL share with spaces", "file://server/Team Share" + mac],
] as const;
const portable = [
  "~/project", "~\\project", "$HOME/project", ["$", "{HOME}/project"].join(""),
  "%USERPROFILE%/project", "$env:USERPROFILE/project", "$HOME", "~",
  "src/home/module.ts", "/usr/share/example", "C:\\Windows\\System32",
  "https://example.test/Users/project/file", "https://example.test/home/project/file",
  "/homepage/project/file", "Users/project/file", "/root", "~synthetic-user/project",
  "%~dp0\\node.exe", "~~~text\\n", "~repo/path/file", "~go/bin/tool",
  "(?:" + ["\\/home\\/", "\\/Users\\/"].join("|") + ")[^/\\s\"']+",
  "./home/module.ts", "../home/module.ts", "./Users/module.ts",
  "~/home/module.ts", "~/Users/module.ts",
  "https://home/project/file", "https://Users/project/file", "https://root/project/file",
  "file://home/project/file", "file://Users/project/file", "file://server/share/project",
  "https://server/share/Users/synthetic-user/project", "//server/share/ordinary/project",
];

describe("concrete private home-path policy", () => {
  it.each(concrete)("detects %s with the same SDK and repository policy", async (_label, value) => {
    const gate = await harness.importModule<{ scanContent(file: string, content: string): Array<{ rule: string }> }>(
      "scripts/check-secrets-lib.mjs",
    );
    const findings = scanMutationSecrets({ note: value });
    expect(findings).toEqual([expect.objectContaining({ rule: "absolute_home_path", path: "$.note" })]);
    expect(gate.scanContent("document.md", value)).toEqual([
      expect.objectContaining({ rule: "absolute-home-path" }),
    ]);
    expect(JSON.stringify(findings)).not.toContain("synthetic-user");
    expect(JSON.stringify(findings)).not.toContain(value);
  });

  it.each(portable)("preserves a portable reference or ordinary non-private path: %s", async (value) => {
    const gate = await harness.importModule<{ scanContent(file: string, content: string): unknown[] }>(
      "scripts/check-secrets-lib.mjs",
    );
    expect(scanMutationSecrets({ note: value })).toEqual([]);
    expect(gate.scanContent("document.md", value)).toEqual([]);
  });

  it("reports safe normalization provenance without changing input or guard modes", () => {
    const payload = { note: encodeURIComponent(unix) };
    const settings = { require_attributed_author: false, secret_guard: "advise", stale_in_progress_hours: 72 } as const;
    const advised = evaluateMutationGuard({ author: "test", payload, settings });
    expect(advised.findings).toEqual([{ rule: "absolute_home_path", path: "$.note", normalizations: ["percent_decode"] }]);
    expect(payload.note).toBe(encodeURIComponent(unix));
    expect(() => evaluateMutationGuard({ author: "test", payload, settings: { ...settings, secret_guard: "block" } }))
      .toThrow(/mutation blocked by secret guard/i);
    expect(evaluateMutationGuard({ author: "test", payload, settings: { ...settings, secret_guard: "off" } }).findings).toEqual([]);
    expect(evaluateMutationGuard({ author: "test", payload, settings: { ...settings, secret_guard: "block" }, force: true }))
      .toMatchObject({ override_applied: true, warnings: expect.arrayContaining(["secret_guard_force_override"]) });
  });

  it("keeps normalized diagnostics on the original source line and retains fixture exemptions", async () => {
    const gate = await harness.importModule<{
      scanContent(file: string, content: string): Array<{ rule: string; line: number }>;
    }>("scripts/check-secrets-lib.mjs");
    const value = "heading\n" + "%0A" + encodeURIComponent(mac) + "\nend";
    expect(gate.scanContent("document.md", value)).toEqual([{ file: "document.md", rule: "absolute-home-path", line: 2 }]);
    expect(gate.scanContent("tests/synthetic.ts", value)).toEqual([]);
    expect(scanMutationSecrets({ note: value })).toEqual([expect.objectContaining({ rule: "absolute_home_path" })]);
  });

  it("requires review for residual encoding without losing other credential findings", () => {
    let value = unix;
    for (let depth = 0; depth < 6; depth += 1) value = encodeURIComponent(value);
    const payload = { note: value, token: "ghp_" + "x".repeat(24) };
    const findings = scanMutationSecrets(payload);
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "absolute_home_path", normalization_incomplete: true }),
      { rule: "github_token", path: "$.token" },
    ]));
    const settings = { require_attributed_author: false, secret_guard: "block", stale_in_progress_hours: 72 } as const;
    expect(() => evaluateMutationGuard({ author: "test", payload, settings })).toThrow(/secret guard/i);
    expect(evaluateMutationGuard({ author: "test", payload, settings, force: true }).override_applied).toBe(true);
    expect(JSON.stringify(findings)).not.toContain(value);
    expect(JSON.stringify(findings)).not.toContain(payload.token);
  });

  it("accepts fully inspected non-private encoding at the final pass", () => {
    let value = "ordinary text";
    for (let depth = 0; depth < 4; depth += 1) value = encodeURIComponent(value);
    expect(scanMutationSecrets({ note: value })).toEqual([]);
  });

  it.each([
    [unix, ["percent_decode"]],
    [encodeURIComponent(unix), ["percent_decode"]],
    [unix.replace("home", "ho\u200bme"), ["unicode_fold", "percent_decode"]],
  ] as const)("preserves incomplete inspection on a later line after %s", (first, normalizations) => {
    let later = unix;
    for (let depth = 0; depth < 6; depth += 1) later = encodeURIComponent(later);
    const payload = { note: first + "\n" + later };
    const settings = { require_attributed_author: false, secret_guard: "advise", stale_in_progress_hours: 72 } as const;
    expect(evaluateMutationGuard({ author: "test", payload, settings }).findings).toEqual([{
      rule: "absolute_home_path", path: "$.note", normalizations, normalization_incomplete: true,
    }]);
  });

  it("keeps one complete finding when later lines contain fully inspected paths", () => {
    expect(scanMutationSecrets({ note: unix + "\n" + encodeURIComponent(mac) })).toEqual([
      { rule: "absolute_home_path", path: "$.note" },
    ]);
  });

  it.each([0, 1, 4])("inspects residual encoding on the same line after a path encoded %i times", (depth) => {
    let first = unix;
    let later = unix;
    for (let pass = 0; pass < depth; pass += 1) first = encodeURIComponent(first);
    for (let pass = 0; pass < 6; pass += 1) later = encodeURIComponent(later);
    expect(scanMutationSecrets({ note: first + " " + later })).toEqual([{
      rule: "absolute_home_path", path: "$.note", normalizations: ["percent_decode"], normalization_incomplete: true,
    }]);
  });

  it("bounds unmatched backslash runs through every normalization pass", async () => {
    const gate = await harness.importModule<{ scanContent(file: string, content: string): unknown[] }>(
      "scripts/check-secrets-lib.mjs",
    );
    let prefix = "ordinary text";
    for (let depth = 0; depth < 4; depth += 1) prefix = encodeURIComponent(prefix);
    const value = prefix + "\\".repeat(200_000) + "z";
    const started = performance.now();
    expect(scanMutationSecrets({ note: value })).toEqual([]);
    expect(gate.scanContent("document.md", value)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it("bounds an adversarial percent chain and returns only inspection status", () => {
    const value = "%" + "25".repeat(50_000);
    const findings = scanMutationSecrets({ note: value });
    expect(findings).toEqual([{
      rule: "absolute_home_path", path: "$.note",
      normalizations: ["percent_decode"], normalization_incomplete: true,
    }]);
    expect(JSON.stringify(findings).length).toBeLessThan(200);
  });
});
