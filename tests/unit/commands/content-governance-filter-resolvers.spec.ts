import { describe, expect, it } from "vitest";

import {
  _testOnly as listTestOnly,
  resolveContentFieldFilters,
  resolveMissingMetadataFilters,
  type ListOptions,
} from "../../../src/cli/commands/list.js";
import { hasListFilters } from "../../../src/cli/commands/list-filter-shared.js";

/**
 * Branch-level coverage for the GH-242 content-field and GH-236
 * governance-missing filter resolvers, the filters-echo helpers, and the
 * hasListFilters extension. These pure helpers carry one branch per field, so
 * each field is exercised present, absent, and conflicting where applicable.
 */

const PRESENCE_FIELDS: Array<[keyof ListOptions, string]> = [
  ["hasNotes", "notes"],
  ["hasLearnings", "learnings"],
  ["hasFiles", "files"],
  ["hasDocs", "docs"],
  ["hasTests", "tests"],
  ["hasComments", "comments"],
  ["hasDeps", "deps"],
  ["hasBody", "body"],
  ["hasLinkedCommand", "linked_command"],
];

const ABSENCE_FIELDS: Array<[keyof ListOptions, string]> = [
  ["noNotes", "notes"],
  ["noLearnings", "learnings"],
  ["noFiles", "files"],
  ["noDocs", "docs"],
  ["noTests", "tests"],
  ["noComments", "comments"],
  ["noDeps", "deps"],
  ["emptyBody", "body"],
  ["noLinkedCommand", "linked_command"],
];

describe("resolveContentFieldFilters", () => {
  it("returns an empty map when no content flag is active", () => {
    expect(resolveContentFieldFilters({})).toEqual({});
  });

  it("maps each presence flag to a 'present' selection", () => {
    for (const [flag, field] of PRESENCE_FIELDS) {
      expect(resolveContentFieldFilters({ [flag]: true })).toEqual({ [field]: "present" });
    }
  });

  it("maps each absence flag to an 'absent' selection", () => {
    for (const [flag, field] of ABSENCE_FIELDS) {
      expect(resolveContentFieldFilters({ [flag]: true })).toEqual({ [field]: "absent" });
    }
  });

  it("throws when a field is requested both present and absent", () => {
    expect(() => resolveContentFieldFilters({ hasNotes: true, noNotes: true })).toThrow(
      /Cannot combine --has-notes with --no-notes/,
    );
    expect(() => resolveContentFieldFilters({ hasBody: true, emptyBody: true })).toThrow(
      /Cannot combine --has-body with --empty-body/,
    );
  });

  it("ignores a present/absent flag set to false", () => {
    expect(resolveContentFieldFilters({ hasNotes: false, noNotes: false })).toEqual({});
  });

  it("composes independent fields", () => {
    expect(resolveContentFieldFilters({ hasNotes: true, emptyBody: true })).toEqual({
      notes: "present",
      body: "absent",
    });
  });
});

describe("resolveMissingMetadataFilters governance flags", () => {
  it("maps every governance-missing flag", () => {
    expect(
      resolveMissingMetadataFilters({
        filterReviewerMissing: true,
        filterRiskMissing: true,
        filterConfidenceMissing: true,
        filterSprintMissing: true,
        filterReleaseMissing: true,
      }),
    ).toMatchObject({
      reviewerMissing: true,
      riskMissing: true,
      confidenceMissing: true,
      sprintMissing: true,
      releaseMissing: true,
    });
  });

  it("defaults governance flags to false when absent", () => {
    expect(resolveMissingMetadataFilters({})).toMatchObject({
      reviewerMissing: false,
      riskMissing: false,
      confidenceMissing: false,
      sprintMissing: false,
      releaseMissing: false,
    });
  });
});

describe("filters echo helpers", () => {
  it("emits the snake_case summary key for each active content flag", () => {
    expect(listTestOnly.buildContentFilterEcho({ hasNotes: true })).toEqual({ has_notes: true });
    expect(listTestOnly.buildContentFilterEcho({ hasLearnings: true })).toEqual({ has_learnings: true });
    expect(listTestOnly.buildContentFilterEcho({ hasFiles: true })).toEqual({ has_files: true });
    expect(listTestOnly.buildContentFilterEcho({ hasDocs: true })).toEqual({ has_docs: true });
    expect(listTestOnly.buildContentFilterEcho({ hasTests: true })).toEqual({ has_tests: true });
    expect(listTestOnly.buildContentFilterEcho({ hasComments: true })).toEqual({ has_comments: true });
    expect(listTestOnly.buildContentFilterEcho({ hasDeps: true })).toEqual({ has_deps: true });
    expect(listTestOnly.buildContentFilterEcho({ hasBody: true })).toEqual({ has_body: true });
    expect(listTestOnly.buildContentFilterEcho({ hasLinkedCommand: true })).toEqual({ has_linked_command: true });
    expect(listTestOnly.buildContentFilterEcho({ noNotes: true })).toEqual({ no_notes: true });
    expect(listTestOnly.buildContentFilterEcho({ noLearnings: true })).toEqual({ no_learnings: true });
    expect(listTestOnly.buildContentFilterEcho({ noFiles: true })).toEqual({ no_files: true });
    expect(listTestOnly.buildContentFilterEcho({ noDocs: true })).toEqual({ no_docs: true });
    expect(listTestOnly.buildContentFilterEcho({ noTests: true })).toEqual({ no_tests: true });
    expect(listTestOnly.buildContentFilterEcho({ noComments: true })).toEqual({ no_comments: true });
    expect(listTestOnly.buildContentFilterEcho({ noDeps: true })).toEqual({ no_deps: true });
    expect(listTestOnly.buildContentFilterEcho({ emptyBody: true })).toEqual({ empty_body: true });
    expect(listTestOnly.buildContentFilterEcho({ noLinkedCommand: true })).toEqual({ no_linked_command: true });
  });

  it("emits nothing for inactive content flags", () => {
    expect(listTestOnly.buildContentFilterEcho({})).toEqual({});
  });

  it("emits the snake_case summary key for each active governance flag", () => {
    expect(listTestOnly.buildGovernanceMissingFilterEcho({ filterReviewerMissing: true })).toEqual({
      filter_reviewer_missing: true,
    });
    expect(listTestOnly.buildGovernanceMissingFilterEcho({ filterRiskMissing: true })).toEqual({
      filter_risk_missing: true,
    });
    expect(listTestOnly.buildGovernanceMissingFilterEcho({ filterConfidenceMissing: true })).toEqual({
      filter_confidence_missing: true,
    });
    expect(listTestOnly.buildGovernanceMissingFilterEcho({ filterSprintMissing: true })).toEqual({
      filter_sprint_missing: true,
    });
    expect(listTestOnly.buildGovernanceMissingFilterEcho({ filterReleaseMissing: true })).toEqual({
      filter_release_missing: true,
    });
    expect(listTestOnly.buildGovernanceMissingFilterEcho({})).toEqual({});
  });
});

describe("hasListFilters with content + governance filters", () => {
  it("returns true for each new content filter field", () => {
    const fields: Array<keyof ListOptions> = [
      ...PRESENCE_FIELDS.map(([flag]) => flag),
      ...ABSENCE_FIELDS.map(([flag]) => flag),
    ];
    for (const field of fields) {
      expect(hasListFilters({ [field]: true } as ListOptions, undefined), String(field)).toBe(true);
    }
  });

  it("returns true for each governance-missing filter field", () => {
    const fields: Array<keyof ListOptions> = [
      "filterReviewerMissing",
      "filterRiskMissing",
      "filterConfidenceMissing",
      "filterSprintMissing",
      "filterReleaseMissing",
    ];
    for (const field of fields) {
      expect(hasListFilters({ [field]: true } as ListOptions, undefined), String(field)).toBe(true);
    }
  });

  it("returns false when no filter is active", () => {
    expect(hasListFilters({}, undefined, { includePagination: false })).toBe(false);
  });
});
