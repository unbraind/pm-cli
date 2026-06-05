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
/**
 * The items that actually render for the given options: the union of all
 * visible release-section items after filtering, empty-section pruning and
 * `--limit`/`--since-version` narrowing. Exposed so semver suggestions and the
 * structured `--changelog-json` document classify the same set the markdown
 * emits (GH #28).
 */
export declare function visibleChangelogItems(options: GenerateChangelogOptions): PmItem[];
/** Classify an explicit item set into a semver bump (no option-driven filtering). */
export declare function suggestSemverForItems(items: PmItem[]): SemverSuggestion;
//# sourceMappingURL=generator.d.ts.map