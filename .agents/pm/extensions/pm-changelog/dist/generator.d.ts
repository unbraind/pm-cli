import type { ChangelogDocument, GeneratedChangelog, GenerateChangelogOptions, MergeChangelogOptions, MergeChangelogResult, PmItem, ReadPmItemsOptions, SemverSuggestion, WriteChangelogOptions, WriteChangelogResult } from "./types.js";
export declare function generateChangelog(options: GenerateChangelogOptions): string;
export declare function createChangelog(options: GenerateChangelogOptions): GeneratedChangelog;
/**
 * OPT-IN (`--changelog-json`): build a structured representation of the
 * changelog (releases -> sections -> items) for downstream tooling. This is
 * deliberately distinct from the `--json` CLI summary (action/bytes/changed)
 * and from the `changelog export --format json` payload (which wraps markdown).
 * It applies the same filtering, limiting and grouping as the markdown path so
 * the two stay in sync, but emits structured data instead of rendered text.
 */
export declare function buildChangelogDocument(options: GenerateChangelogOptions): ChangelogDocument;
export declare function mergeChangelog(existingMarkdown: string | undefined, generatedMarkdown: string, options?: MergeChangelogOptions): MergeChangelogResult;
export declare function readPmItems(options?: ReadPmItemsOptions): PmItem[];
export declare function writeChangelog(options: WriteChangelogOptions): WriteChangelogResult;
export declare function parsePmItemsJson(raw: string): PmItem[];
/**
 * OPT-IN (`--suggest-semver`): classify the in-scope items into breaking /
 * feature / fix / other and recommend a semver bump. Emitted as JSON or a
 * footer note; never alters default markdown.
 */
export declare function suggestSemver(options: GenerateChangelogOptions): SemverSuggestion;
//# sourceMappingURL=generator.d.ts.map