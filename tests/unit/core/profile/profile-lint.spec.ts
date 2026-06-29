import { describe, expect, it } from "vitest";
import {
  lintProjectProfile,
  PROFILE_LINT_CODES,
  PROFILE_LINT_DIMENSIONS,
  type ProfileLintCode,
} from "../../../../src/core/profile/profile-lint.js";
import type { ProjectProfileDefinition } from "../../../../src/core/profile/profile-presets.js";
import { BUILTIN_PROFILES } from "../../../../src/core/profile/profile-presets.js";

/**
 * Unit coverage for {@link lintProjectProfile}: the author-time, tracker-independent
 * consistency linter for project profiles. Each case targets one finding code (or
 * confirms a clean dimension) so the graded error/warning model and every branch
 * stay covered.
 */

/** Build a fully-empty profile, overriding only the dimension under test. */
function makeProfile(overrides: Partial<ProjectProfileDefinition> = {}): ProjectProfileDefinition {
  return {
    name: "flow",
    title: "Flow",
    summary: "Flow archetype.",
    types: [],
    statuses: [],
    fields: [],
    workflows: [],
    config: [],
    templates: [],
    packages: [],
    ...overrides,
  };
}

/** Collect the finding codes a profile produces. */
function codesOf(profile: ProjectProfileDefinition): ProfileLintCode[] {
  return lintProjectProfile(profile).findings.map((finding) => finding.code);
}

describe("lintProjectProfile", () => {
  it("reports a clean profile with no findings", () => {
    const report = lintProjectProfile(makeProfile());
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.errorCount).toBe(0);
    expect(report.warningCount).toBe(0);
    expect(report.profile).toBe("flow");
  });

  it("lints every built-in archetype clean", () => {
    for (const profile of Object.values(BUILTIN_PROFILES)) {
      const report = lintProjectProfile(profile);
      expect(report.findings, `${profile.name} should lint clean`).toEqual([]);
      expect(report.ok).toBe(true);
    }
  });

  it("exposes stable code and dimension vocabularies", () => {
    expect(PROFILE_LINT_CODES).toContain("workflow_status_unknown");
    expect(PROFILE_LINT_DIMENSIONS).toContain("workflows");
  });

  describe("profile identity", () => {
    it("errors on an empty name", () => {
      const report = lintProjectProfile(makeProfile({ name: "  " }));
      expect(report.ok).toBe(false);
      expect(report.profile).toBe("  ");
      expect(report.findings[0]).toMatchObject({ severity: "error", code: "profile_name_empty", dimension: "profile" });
    });

    it("warns when the name is not in canonical form", () => {
      const report = lintProjectProfile(makeProfile({ name: "My-Flow" }));
      const finding = report.findings.find((entry) => entry.code === "profile_name_not_normalized");
      expect(finding).toMatchObject({ severity: "warning", target: "My-Flow" });
      expect(finding?.message).toContain("my_flow");
    });

    it("does not warn when the name is already canonical", () => {
      expect(codesOf(makeProfile({ name: "my_flow" }))).not.toContain("profile_name_not_normalized");
    });

    it("warns on an empty title and summary", () => {
      const codes = codesOf(makeProfile({ title: " ", summary: "" }));
      expect(codes).toContain("profile_title_empty");
      expect(codes).toContain("profile_summary_empty");
    });
  });

  describe("types", () => {
    it("errors when a type name is invalid (missing)", () => {
      const report = lintProjectProfile(makeProfile({ types: [{ name: undefined }] }));
      expect(report.findings[0]).toMatchObject({ code: "type_invalid", dimension: "types", target: "#0" });
    });

    it("errors when a type redefines a built-in, keyed by the offending name", () => {
      const report = lintProjectProfile(makeProfile({ types: [{ name: "Epic" }] }));
      expect(report.findings[0]).toMatchObject({ code: "type_invalid", target: "Epic" });
    });

    it("errors on a case-insensitive duplicate type", () => {
      const report = lintProjectProfile(makeProfile({ types: [{ name: "Story" }, { name: "story" }] }));
      expect(report.findings).toHaveLength(1);
      expect(report.findings[0]).toMatchObject({ code: "type_duplicate", target: "story" });
    });

    it("accepts distinct custom types", () => {
      expect(codesOf(makeProfile({ types: [{ name: "Story" }, { name: "Spike" }] }))).toEqual([]);
    });
  });

  describe("statuses", () => {
    it("errors when a status id is invalid (missing)", () => {
      const report = lintProjectProfile(makeProfile({ statuses: [{ id: undefined }] }));
      expect(report.findings[0]).toMatchObject({ code: "status_invalid", dimension: "statuses", target: "#0" });
    });

    it("errors when a status overrides a built-in id", () => {
      const report = lintProjectProfile(makeProfile({ statuses: [{ id: "open" }] }));
      expect(report.findings[0]).toMatchObject({ code: "status_invalid", target: "open" });
    });

    it("errors on a duplicate status id", () => {
      const report = lintProjectProfile(makeProfile({ statuses: [{ id: "review" }, { id: "review" }] }));
      expect(report.findings).toHaveLength(1);
      expect(report.findings[0]).toMatchObject({ code: "status_duplicate", target: "review" });
    });

    it("accepts statuses with and without aliases", () => {
      expect(
        codesOf(makeProfile({ statuses: [{ id: "review", aliases: ["in-review"] }, { id: "approved" }] })),
      ).toEqual([]);
    });
  });

  describe("fields", () => {
    it("errors when a field key is invalid (missing)", () => {
      const report = lintProjectProfile(makeProfile({ fields: [{ key: undefined }] }));
      expect(report.findings[0]).toMatchObject({ code: "field_invalid", dimension: "fields", target: "#0" });
    });

    it("errors when a field shadows a built-in key", () => {
      const report = lintProjectProfile(makeProfile({ fields: [{ key: "priority" }] }));
      expect(report.findings[0]).toMatchObject({ code: "field_invalid", target: "priority" });
    });

    it("errors on a duplicate field key", () => {
      const report = lintProjectProfile(makeProfile({ fields: [{ key: "points" }, { key: "points" }] }));
      expect(report.findings).toHaveLength(1);
      expect(report.findings[0]).toMatchObject({ code: "field_duplicate", target: "points" });
    });

    it("accepts distinct custom fields", () => {
      expect(codesOf(makeProfile({ fields: [{ key: "points" }, { key: "severity" }] }))).toEqual([]);
    });
  });

  describe("workflows", () => {
    it("errors on a workflow with an empty type", () => {
      const report = lintProjectProfile(makeProfile({ workflows: [{ type: "  ", allowed_transitions: [] }] }));
      expect(report.findings[0]).toMatchObject({ code: "workflow_type_empty", severity: "error", target: "#0" });
    });

    it("warns when a workflow governs an undeclared type", () => {
      const report = lintProjectProfile(makeProfile({ workflows: [{ type: "Ghost", allowed_transitions: [] }] }));
      expect(report.findings[0]).toMatchObject({ code: "workflow_type_unknown", severity: "warning", target: "Ghost" });
    });

    it("accepts a workflow governing a built-in type", () => {
      expect(
        codesOf(makeProfile({ workflows: [{ type: "Task", allowed_transitions: [["open", "closed"]] }] })),
      ).toEqual([]);
    });

    it("accepts a workflow governing a profile-declared type", () => {
      expect(
        codesOf(
          makeProfile({
            types: [{ name: "Story" }],
            statuses: [{ id: "review" }],
            workflows: [{ type: "Story", allowed_transitions: [["open", "review"]] }],
          }),
        ),
      ).toEqual([]);
    });

    it("warns on a duplicate workflow type", () => {
      const codes = codesOf(
        makeProfile({
          workflows: [
            { type: "Task", allowed_transitions: [["open", "closed"]] },
            { type: "Task", allowed_transitions: [["open", "blocked"]] },
          ],
        }),
      );
      expect(codes).toContain("workflow_duplicate_type");
    });

    it("does not emit workflow_type_unknown twice for a duplicate undeclared type", () => {
      const codes = codesOf(
        makeProfile({
          workflows: [
            { type: "Ghost", allowed_transitions: [] },
            { type: "Ghost", allowed_transitions: [] },
          ],
        }),
      );
      // First occurrence: unknown (warning). Second: duplicate only — not a
      // redundant second unknown.
      expect(codes.filter((code) => code === "workflow_type_unknown")).toHaveLength(1);
      expect(codes).toContain("workflow_duplicate_type");
    });

    it("reports an unknown status once per workflow, not globally", () => {
      const report = lintProjectProfile(
        makeProfile({
          workflows: [
            { type: "Task", allowed_transitions: [["open", "reviewed"]] },
            { type: "Chore", allowed_transitions: [["open", "reviewed"]] },
          ],
        }),
      );
      const unknown = report.findings.filter((entry) => entry.code === "workflow_status_unknown");
      expect(unknown).toHaveLength(2);
    });

    it("errors on transitions with an empty from or to status", () => {
      const report = lintProjectProfile(
        makeProfile({
          workflows: [{ type: "Task", allowed_transitions: [["", "open"], ["open", ""]] }],
        }),
      );
      const malformed = report.findings.filter((entry) => entry.code === "workflow_transition_malformed");
      expect(malformed).toHaveLength(2);
    });

    it("warns once per unknown status token across transitions", () => {
      const report = lintProjectProfile(
        makeProfile({
          workflows: [
            { type: "Task", allowed_transitions: [["open", "reviewed"], ["reviewed", "closed"]] },
          ],
        }),
      );
      const unknown = report.findings.filter((entry) => entry.code === "workflow_status_unknown");
      expect(unknown).toHaveLength(1);
      expect(unknown[0]).toMatchObject({ target: "reviewed", severity: "warning" });
    });

    it("treats a status alias as a known token", () => {
      expect(
        codesOf(
          makeProfile({
            statuses: [{ id: "review", aliases: ["in-review"] }],
            workflows: [{ type: "Task", allowed_transitions: [["open", "in-review"]] }],
          }),
        ),
      ).toEqual([]);
    });

    it("treats a built-in status alias as a known token", () => {
      expect(
        codesOf(makeProfile({ workflows: [{ type: "Task", allowed_transitions: [["open", "cancelled"]] }] })),
      ).toEqual([]);
    });
  });

  describe("config", () => {
    it("errors on an unknown config key", () => {
      const report = lintProjectProfile(
        makeProfile({ config: [{ key: "not_a_key", value: "x", summary: "" }] }),
      );
      expect(report.findings[0]).toMatchObject({ code: "config_key_unknown", target: "not_a_key" });
    });

    it("errors on an invalid config value", () => {
      const report = lintProjectProfile(
        makeProfile({ config: [{ key: "search_max_results", value: "abc", summary: "" }] }),
      );
      expect(report.findings[0]).toMatchObject({ code: "config_value_invalid", target: "search_max_results" });
    });

    it("accepts a valid config knob", () => {
      expect(codesOf(makeProfile({ config: [{ key: "search_provider", value: "bm25", summary: "" }] }))).toEqual([]);
    });

    it("errors on a duplicate config knob (alias-folded to the same descriptor)", () => {
      const report = lintProjectProfile(
        makeProfile({
          config: [
            { key: "search_provider", value: "bm25", summary: "" },
            { key: "search-provider", value: "bm25", summary: "" },
          ],
        }),
      );
      expect(report.findings).toHaveLength(1);
      expect(report.findings[0]).toMatchObject({ code: "config_duplicate", target: "search_provider" });
    });
  });

  describe("templates", () => {
    it("ignores templates without a type option", () => {
      expect(codesOf(makeProfile({ templates: [{ name: "t", options: { priority: "1" } }] }))).toEqual([]);
    });

    it("ignores templates with an empty type option", () => {
      expect(codesOf(makeProfile({ templates: [{ name: "t", options: { type: "  " } }] }))).toEqual([]);
    });

    it("warns when a template creates an undeclared type", () => {
      const report = lintProjectProfile(makeProfile({ templates: [{ name: "t", options: { type: "Nope" } }] }));
      expect(report.findings[0]).toMatchObject({ code: "template_type_unknown", target: "t" });
    });

    it("accepts a template creating a built-in type", () => {
      expect(codesOf(makeProfile({ templates: [{ name: "t", options: { type: "Task" } }] }))).toEqual([]);
    });

    it("accepts a template creating a profile-declared type", () => {
      expect(
        codesOf(makeProfile({ types: [{ name: "Story" }], templates: [{ name: "t", options: { type: "Story" } }] })),
      ).toEqual([]);
    });
  });

  describe("packages", () => {
    it("warns on an empty package spec", () => {
      const report = lintProjectProfile(makeProfile({ packages: [{ spec: "  ", reason: "x" }] }));
      expect(report.findings[0]).toMatchObject({ code: "package_spec_empty", target: "#0" });
    });

    it("accepts a non-empty package spec", () => {
      expect(codesOf(makeProfile({ packages: [{ spec: "templates", reason: "x" }] }))).toEqual([]);
    });
  });

  it("tallies error and warning counts and sets ok=false on any error", () => {
    const report = lintProjectProfile(
      makeProfile({
        title: "",
        types: [{ name: "Story" }, { name: "story" }],
        workflows: [{ type: "Ghost", allowed_transitions: [] }],
      }),
    );
    expect(report.errorCount).toBe(1);
    expect(report.warningCount).toBe(2);
    expect(report.ok).toBe(false);
  });
});
