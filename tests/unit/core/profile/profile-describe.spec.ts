import { describe, expect, it } from "vitest";
import {
  describeProfileComposition,
  describeProjectProfile,
} from "../../../../src/core/profile/profile-describe.js";
import { BUILTIN_PROFILES } from "../../../../src/core/profile/profile-presets.js";

/**
 * Unit coverage for the {@link describeProjectProfile} author-time describe
 * primitive: per-dimension counts and the resolved entry identifiers the CLI
 * `pm profile show`/`list` surfaces reuse.
 */
describe("describeProjectProfile", () => {
  it("counts every dimension of the agile archetype", () => {
    const composition = describeProfileComposition(BUILTIN_PROFILES.agile);
    expect(composition).toEqual({
      types: 2,
      statuses: 1,
      fields: 2,
      workflows: 1,
      config: 2,
      templates: 1,
      packages: 3,
    });
  });

  it("surfaces canonical type names and per-dimension identifiers", () => {
    const description = describeProjectProfile(BUILTIN_PROFILES.agile);
    expect(description).toMatchObject({
      name: "agile",
      title: "Agile delivery",
      types: ["Story", "Spike"],
      statuses: ["review"],
      fields: ["story_points", "acceptance_owner"],
      workflows: ["Story"],
      templates: ["story"],
    });
    expect(description.config).toEqual(["search_provider=bm25", "search_max_results=20"]);
    expect(description.packages[0]).toEqual({
      spec: "templates",
      reason: "Reusable create templates for recurring story shapes.",
    });
    expect(description.composition.types).toBe(2);
  });

  it("describes an empty profile with zeroed counts and empty lists", () => {
    const description = describeProjectProfile({
      name: "blank",
      title: "Blank",
      summary: "",
      types: [],
      statuses: [],
      fields: [],
      workflows: [],
      config: [],
      templates: [],
      packages: [],
    });
    expect(description.composition).toEqual({
      types: 0,
      statuses: 0,
      fields: 0,
      workflows: 0,
      config: 0,
      templates: 0,
      packages: 0,
    });
    expect(description.types).toEqual([]);
    expect(description.packages).toEqual([]);
  });

  it("coerces missing status ids and field keys to empty strings", () => {
    const description = describeProjectProfile({
      name: "sparse",
      title: "Sparse",
      summary: "",
      types: [],
      statuses: [{ id: undefined }],
      fields: [{ key: undefined }],
      workflows: [],
      config: [],
      templates: [],
      packages: [],
    });
    expect(description.statuses).toEqual([""]);
    expect(description.fields).toEqual([""]);
  });
});
