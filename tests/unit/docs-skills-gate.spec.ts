import { describe, expect, it } from "vitest";
import {
  extractFrontmatter,
  parseSimpleYamlMap,
  resolveExampleCommandPath,
  validateSkillFrontmatter,
} from "../../scripts/release/docs-skills-gate.mjs";

describe("docs-skills gate helpers", () => {
  it("extracts frontmatter and body content", () => {
    const source = ["---", "name: pm-developer", "description: Example. Use when testing.", "---", "", "# Body"].join("\n");
    const extracted = extractFrontmatter(source);
    expect(extracted.frontmatter).toContain("name: pm-developer");
    expect(extracted.body).toContain("# Body");
  });

  it("parses simple YAML key/value pairs", () => {
    const values = parseSimpleYamlMap("name: pm-user\ndescription: Example. Use when routing.");
    expect(values.get("name")).toBe("pm-user");
    expect(values.get("description")).toContain("Use when");
  });

  it("validates required skill frontmatter fields", () => {
    const failures: string[] = [];
    validateSkillFrontmatter(
      "pm-user",
      ["---", "name: pm-wrong", "description: Missing routing sentence.", "---", "", "# body without guide route"].join("\n"),
      failures,
    );
    expect(failures.some((entry) => entry.includes("must match directory name"))).toBe(true);
    expect(failures.some((entry) => entry.includes('explicit "Use when"'))).toBe(true);
    expect(failures.some((entry) => entry.includes("must include optional pm guide routing"))).toBe(true);
    expect(failures.some((entry) => entry.includes("must mention installing guide-shell"))).toBe(true);
  });

  it("resolves command examples against known command set", () => {
    const known = new Set(["guide", "contracts", "beads import", "extension", "test-runs"]);
    expect(resolveExampleCommandPath("pm guide skills --depth deep", known)).toBe("guide");
    expect(resolveExampleCommandPath("pm beads import --file -", known)).toBe("beads import");
    expect(resolveExampleCommandPath("pm test-runs list --json", known)).toBe("test-runs");
    expect(resolveExampleCommandPath("pm <command> --help", known)).toBeNull();
    expect(resolveExampleCommandPath("pm unknown-command --help", known)).toBe("");
  });
});
