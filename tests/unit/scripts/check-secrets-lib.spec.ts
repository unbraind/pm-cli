import { describe, expect, it } from "vitest";

import { createScriptHarness } from "../../helpers/scriptModule";

interface CheckSecretsLibModule {
  RULES: Array<{ name: string; regex: RegExp; includeFiles?: RegExp; excludeFiles?: RegExp }>;
  scanContent: (file: string, content: string) => Array<{ file: string; rule: string; line: number }>;
}

const harness = createScriptHarness();

describe("check-secrets-lib", () => {
  // Each harness.importModule call returns a fresh, cache-busted module instance
  // with its own RULES array, so synthetic-rule mutations never leak between tests.

  it("computes one-based line numbers across multiple newlines", async () => {
    const mod = await harness.importModule<CheckSecretsLibModule>("scripts/check-secrets-lib.mjs");
    const token = `ghp_${"A1b2C3d4".repeat(5)}`;
    const content = ["l1", "l2", "l3", "l4", `tok ${token}`].join("\n");
    const findings = mod.scanContent("a.txt", content);
    expect(findings.find((finding) => finding.rule === "github-token")?.line).toBe(5);
  });

  it("computes a line number of 1 for a match on the first line", async () => {
    const mod = await harness.importModule<CheckSecretsLibModule>("scripts/check-secrets-lib.mjs");
    const token = `ghp_${"A1b2C3d4".repeat(5)}`;
    const first = mod.scanContent("b.txt", `${token}\nrest`);
    expect(first.find((finding) => finding.rule === "github-token")?.line).toBe(1);
  });

  it("skips a rule whose includeFiles pattern does not match the file path", async () => {
    const mod = await harness.importModule<CheckSecretsLibModule>("scripts/check-secrets-lib.mjs");
    mod.RULES.push({ name: "synthetic-include", regex: /SYNTHETIC_MARKER/g, includeFiles: /^only-here\// });
    // File path does not match includeFiles -> guarded continue skips the rule.
    const skipped = mod.scanContent("elsewhere.txt", "SYNTHETIC_MARKER");
    expect(skipped.some((finding) => finding.rule === "synthetic-include")).toBe(false);
    // File path matches includeFiles -> rule runs and matches.
    const matched = mod.scanContent("only-here/file.txt", "SYNTHETIC_MARKER");
    expect(matched.some((finding) => finding.rule === "synthetic-include")).toBe(true);
    mod.RULES.pop();
  });

  it("skips a rule whose excludeFiles pattern matches the file path", async () => {
    const mod = await harness.importModule<CheckSecretsLibModule>("scripts/check-secrets-lib.mjs");
    // absolute-home-path rule carries excludeFiles /^(?:tests\/|examples\/)/.
    const homePath = "/home/example/project/file.ts";
    const excluded = mod.scanContent("tests/foo.txt", homePath);
    expect(excluded.some((finding) => finding.rule === "absolute-home-path")).toBe(false);
    const included = mod.scanContent("src/foo.txt", homePath);
    expect(included.some((finding) => finding.rule === "absolute-home-path")).toBe(true);
  });

  it("flags every GitHub token prefix, not just personal access tokens", async () => {
    const mod = await harness.importModule<CheckSecretsLibModule>("scripts/check-secrets-lib.mjs");
    const rulesFor = (file: string, content: string): string[] =>
      mod.scanContent(file, content).map((finding) => finding.rule);
    for (const prefix of ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"]) {
      const token = `${prefix}${"A1b2C3d4".repeat(5)}`;
      expect(rulesFor("notes.md", `token ${token}`)).toContain("github-token");
    }
    expect(rulesFor("notes.md", `pat github_pat_${"x".repeat(30)}`)).toContain("github-token");
  });

  it("flags other high-risk credential shapes", async () => {
    const mod = await harness.importModule<CheckSecretsLibModule>("scripts/check-secrets-lib.mjs");
    const rulesFor = (file: string, content: string): string[] =>
      mod.scanContent(file, content).map((finding) => finding.rule);
    // Fixtures are assembled at runtime so the scanner never flags this spec's own source.
    const privateKey = `-----BEGIN OPENSSH ${"PRIVATE KEY"}-----`;
    const privateIp = `192.168.${"1.183"}`;
    expect(rulesFor("a.txt", privateKey)).toContain("private-key");
    expect(rulesFor("a.txt", `AKIA${"ABCDEFGH12345678"}`)).toContain("aws-access-key");
    expect(rulesFor("a.txt", `sntrys_${"y".repeat(40)}`)).toContain("sentry-org-token");
    expect(rulesFor("a.txt", `ssh user@${privateIp}`)).toContain("private-ssh-target");
    expect(rulesFor("a.txt", privateIp)).toContain("private-ip");
    expect(rulesFor("a.txt", `sk-ant-${"a".repeat(24)}`)).toContain("anthropic-api-key");
    expect(rulesFor("a.txt", `sk-ant-${"a".repeat(24)}`)).not.toContain("openai-api-key");
    expect(rulesFor("a.txt", `sk-${"a1".repeat(12)}`)).toContain("openai-api-key");
    expect(rulesFor("a.txt", `sk-proj-${"a1".repeat(12)}`)).toContain("openai-api-key");
    expect(rulesFor("a.txt", `sk-proj-${"a_".repeat(12)}`)).toContain("openai-api-key");
    expect(rulesFor("a.txt", `glpat-${"b".repeat(20)}`)).toContain("gitlab-token");
  });

  it("does not flag clean documentation content", async () => {
    const mod = await harness.importModule<CheckSecretsLibModule>("scripts/check-secrets-lib.mjs");
    expect(mod.scanContent("README.md", "Install via npm and run pm health.")).toHaveLength(0);
  });

  it("exposes a non-empty rule set for the secret scanner", async () => {
    const mod = await harness.importModule<CheckSecretsLibModule>("scripts/check-secrets-lib.mjs");
    expect(Array.isArray(mod.RULES)).toBe(true);
    expect(mod.RULES.length).toBeGreaterThan(10);
  });
});
