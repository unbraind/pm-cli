import { describe, expect, it } from "vitest";

// @ts-expect-error - plain ESM script without type declarations
import { RULES, scanContent } from "../../scripts/check-secrets.mjs";

function rulesFor(file: string, content: string): string[] {
  return scanContent(file, content).map((finding: { rule: string }) => finding.rule);
}

describe("check-secrets rules", () => {
  it("flags every GitHub token prefix, not just personal access tokens", () => {
    for (const prefix of ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"]) {
      const token = `${prefix}${"A1b2C3d4".repeat(5)}`;
      expect(rulesFor("notes.md", `token ${token}`)).toContain("github-token");
    }
    expect(rulesFor("notes.md", `pat github_pat_${"x".repeat(30)}`)).toContain("github-token");
  });

  it("flags other high-risk credential shapes", () => {
    // Fixtures are assembled at runtime so the scanner never flags this spec's own source.
    const privateKey = `-----BEGIN OPENSSH ${"PRIVATE KEY"}-----`;
    const privateIp = `192.168.${"1.183"}`;
    expect(rulesFor("a.txt", privateKey)).toContain("private-key");
    expect(rulesFor("a.txt", `AKIA${"ABCDEFGH12345678"}`)).toContain("aws-access-key");
    expect(rulesFor("a.txt", `sntrys_${"y".repeat(40)}`)).toContain("sentry-org-token");
    expect(rulesFor("a.txt", `ssh user@${privateIp}`)).toContain("private-ssh-target");
    expect(rulesFor("a.txt", privateIp)).toContain("private-ip");
  });

  it("does not flag clean documentation content", () => {
    expect(rulesFor("README.md", "Install via npm and run pm health.")).toHaveLength(0);
  });

  it("honors excludeFiles for path/host heuristics under tests and examples", () => {
    expect(rulesFor("src/x.ts", "path /home/steve/secret/file")).toContain("absolute-home-path");
    expect(rulesFor("tests/x.spec.ts", "path /home/steve/secret/file")).not.toContain("absolute-home-path");
  });

  it("reports one-based line numbers for findings", () => {
    const token = `ghp_${"A1b2C3d4".repeat(5)}`;
    const findings = scanContent("a.txt", ["line1", "line2", `token ${token}`].join("\n"));
    expect(findings.find((finding: { rule: string }) => finding.rule === "github-token")?.line).toBe(3);
  });

  it("exposes a non-empty rule set for the secret scanner", () => {
    expect(Array.isArray(RULES)).toBe(true);
    expect(RULES.length).toBeGreaterThan(10);
  });
});
