import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineExtension, listAllFrontMatter, locateItem, readLocatedItem, readSettings, resolveItemTypeRegistry, EXIT_CODE, PmCliError, } from "@unbrained/pm-cli/sdk";
import { buildChangelogDocument, createChangelog, explainChangelogSelection, mergeChangelog, suggestSemver, writeChangelog } from "./generator.js";
import { resolveReleaseContext, resolveReleaseTagWindows } from "./release-context.js";
export default defineExtension({
    name: "pm-changelog",
    version: "2026.6.30",
    activate(api) {
        api.registerCommand({
            name: "changelog generate",
            description: "Generate a CHANGELOG.md file from pm items.",
            intent: "generate changelog release notes from completed pm items",
            examples: [
                "pm changelog generate",
                "pm changelog generate --release-version 1.2.0",
                "pm changelog generate --release-version-from-package --since-previous-tag --until-release-tag",
                "pm changelog generate --all-release-tags --mode replace",
                "pm changelog generate --output RELEASE_NOTES.md --since 2026-05-01",
                "pm changelog generate --stdout --group-by release",
                "pm changelog generate --stdout --group-by milestone",
                "pm changelog generate --check --mode prepend --release-version 1.2.0",
            ],
            flags: [
                { long: "--output", value_name: "file", description: "Output file path (default: CHANGELOG.md)" },
                { long: "--stdout", description: "Return markdown instead of writing a file" },
                { long: "--title", value_name: "text", description: "Changelog title (default: Changelog)" },
                { long: "--release-version", value_name: "version", description: "Release/version heading (default: Unreleased)" },
                { long: "--release-version-from-package", description: "Read release/version heading from nearest package.json" },
                { long: "--date", value_name: "date", description: "Release date (default: resolved tag date when available, otherwise today)" },
                { long: "--since", value_name: "date", description: "Include items changed on or after this date" },
                { long: "--since-previous-tag", description: "Derive --since from the previous git tag" },
                { long: "--until", value_name: "date", description: "Include items changed on or before this date" },
                { long: "--until-release-tag", description: "Derive --until from the current release tag when it exists" },
                { long: "--all-release-tags", description: "Rebuild full history from git release tag windows" },
                { long: "--release-tag-pattern", value_name: "glob", description: "Git tag glob for --all-release-tags (default: v*)" },
                { long: "--status", value_name: "list", description: "Comma-separated statuses (default: closed)" },
                { long: "--group-by", value_name: "mode", description: "version, release, or milestone (default: version)" },
                { long: "--section-by", value_name: "mode", description: "Within-release grouping: category, type, status, or label (default: category)" },
                { long: "--conventional", description: "Use Conventional-Commits headings (Features/Bug Fixes/...) for category grouping" },
                { long: "--contributors", description: "Append a Contributors list per release from item assignee/author" },
                { long: "--limit", value_name: "n", description: "Keep only the most recent N release sections (history modes only)" },
                { long: "--since-version", value_name: "version", description: "Keep only releases at or newer than this version (history modes only)" },
                { long: "--breaking-changes", description: "Emit a Breaking Changes section listing items detected as breaking" },
                { long: "--suggest-semver", description: "Return a suggested semver bump (major/minor/patch); never writes the changelog" },
                { long: "--body-preview", value_name: "n", description: "Append the first N chars of each item body to its entry" },
                { long: "--emoji-prefix", description: "Prefix section headings with conventional emoji (Added 🎉, Fixed 🐛, ...)" },
                { long: "--include-metadata", description: "Append compact item metadata (type/status/priority/release/milestone) to each entry" },
                { long: "--changelog-json", description: "Return the full structured changelog document (releases->sections->items)" },
                { long: "--explain", description: "Return item-selection diagnostics (counts, exclusions, hints)" },
                { long: "--mode", value_name: "mode", description: "replace or prepend existing changelog (default: replace)" },
                { long: "--include-empty", description: "Emit an empty release section when no items match" },
                { long: "--include-links", description: "Include item URLs in generated entries (default: false)" },
                { long: "--item-url-base", value_name: "url", description: "Make item IDs clickable links to .toon files under the base URL" },
                { long: "--check", description: "Do not write; report whether the changelog would change" },
            ],
            async run(ctx) {
                const output = ctx.options["output"] ?? "CHANGELOG.md";
                const stdout = Boolean(ctx.options["stdout"]);
                const groupByOption = stringOption(ctx.options, "group-by", "groupBy") ?? "version";
                const modeOption = ctx.options["mode"] ?? "replace";
                // Throw (with a numeric exitCode) rather than returning { error }: the
                // runtime treats a returned object as a successful run (exit 0), so a
                // returned error silently passed validation failures. A PmCliError
                // carries its exitCode so the handler exits non-zero and runs once.
                if (groupByOption !== "version" && groupByOption !== "release" && groupByOption !== "milestone") {
                    throw new PmCliError("--group-by must be 'version', 'release', or 'milestone'", EXIT_CODE.USAGE);
                }
                if (modeOption !== "replace" && modeOption !== "prepend") {
                    throw new PmCliError("--mode must be 'replace' or 'prepend'", EXIT_CODE.USAGE);
                }
                const sectionByOption = stringOption(ctx.options, "section-by", "sectionBy") ?? "category";
                if (sectionByOption !== "category" && sectionByOption !== "type" && sectionByOption !== "status" && sectionByOption !== "label") {
                    throw new PmCliError("--section-by must be 'category', 'type', 'status', or 'label'", EXIT_CODE.USAGE);
                }
                const limitValue = parseLimitOption(ctx.options);
                const groupBy = groupByOption;
                const sectionBy = sectionByOption;
                const mode = modeOption;
                const statuses = ctx.options["status"]
                    ?.split(",")
                    .map((status) => status.trim())
                    .filter(Boolean);
                const allReleaseTags = booleanOption(ctx.options, "all-release-tags", "allReleaseTags");
                const releaseVersion = stringOption(ctx.options, "release-version", "releaseVersion");
                const titleOption = stringOption(ctx.options, "title", "title");
                const dateOption = stringOption(ctx.options, "date", "date");
                const sinceOption = stringOption(ctx.options, "since", "since");
                const untilOption = stringOption(ctx.options, "until", "until");
                const releaseContext = allReleaseTags
                    ? { version: undefined, date: undefined, since: undefined, until: undefined }
                    : resolveReleaseContext({
                        cwd: ctx.pm_root,
                        version: releaseVersion,
                        versionFromPackage: booleanOption(ctx.options, "release-version-from-package", "releaseVersionFromPackage"),
                        since: sinceOption,
                        sincePreviousTag: booleanOption(ctx.options, "since-previous-tag", "sincePreviousTag"),
                        until: untilOption,
                        untilReleaseTag: booleanOption(ctx.options, "until-release-tag", "untilReleaseTag"),
                    });
                const releaseWindows = allReleaseTags
                    ? resolveReleaseTagWindows({
                        cwd: ctx.pm_root,
                        tagPattern: stringOption(ctx.options, "release-tag-pattern", "releaseTagPattern"),
                        pendingVersion: releaseVersion,
                        pendingTimestamp: untilOption ?? dateOption,
                    })
                    : undefined;
                const items = (await listAllFrontMatter(ctx.pm_root));
                const bodyPreview = parseBodyPreviewOption(ctx.options);
                // listAllFrontMatter omits item bodies, so --body-preview would silently
                // render nothing (GH #27). Load bodies on demand only when previewing.
                if (bodyPreview !== undefined && bodyPreview > 0) {
                    await enrichItemBodies(ctx.pm_root, items);
                }
                const generationOptions = {
                    items,
                    title: titleOption,
                    version: releaseContext.version,
                    date: dateOption ?? releaseContext.date,
                    since: releaseContext.since,
                    until: releaseContext.until,
                    releaseWindows,
                    includeStatuses: statuses,
                    groupBy,
                    sectionBy,
                    conventional: booleanOption(ctx.options, "conventional", "conventional"),
                    contributors: booleanOption(ctx.options, "contributors", "contributors"),
                    limit: limitValue,
                    sinceVersion: stringOption(ctx.options, "since-version", "sinceVersion"),
                    breakingChanges: booleanOption(ctx.options, "breaking-changes", "breakingChanges"),
                    bodyPreview,
                    emojiPrefix: booleanOption(ctx.options, "emoji-prefix", "emojiPrefix"),
                    includeMetadata: booleanOption(ctx.options, "include-metadata", "includeMetadata"),
                    suggestSemver: booleanOption(ctx.options, "suggest-semver", "suggestSemver"),
                    includeEmpty: booleanOption(ctx.options, "include-empty", "includeEmpty"),
                    includeLinks: booleanOption(ctx.options, "include-links", "includeLinks"),
                    itemUrlBase: stringOption(ctx.options, "item-url-base", "itemUrlBase"),
                };
                const selectionReport = booleanOption(ctx.options, "explain", "explain")
                    ? explainChangelogSelection(generationOptions)
                    : undefined;
                // OPT-IN (`--changelog-json`): structured document; never writes a file.
                if (booleanOption(ctx.options, "changelog-json", "changelogJson")) {
                    const document = buildChangelogDocument(generationOptions);
                    return {
                        document,
                        format: "json",
                        item_count: document.item_count,
                        ...(selectionReport ? { selection_report: selectionReport } : {}),
                    };
                }
                // OPT-IN (`--suggest-semver`) standalone: emit only the semver analysis;
                // never writes a file and never alters default markdown.
                if (booleanOption(ctx.options, "suggest-semver", "suggestSemver")) {
                    const suggestion = suggestSemver(generationOptions);
                    return {
                        suggested_semver: suggestion,
                        format: "json",
                        ...(selectionReport ? { selection_report: selectionReport } : {}),
                    };
                }
                const generated = createChangelog(generationOptions);
                if (stdout) {
                    const merged = mode === "prepend"
                        ? mergeChangelog(undefined, generated.markdown, { title: titleOption })
                        : { markdown: generated.markdown, action: "replaced", changed: true };
                    return {
                        changelog: merged.markdown,
                        action: merged.action,
                        changed: merged.changed,
                        item_count: generated.itemCount,
                        ...(selectionReport ? { selection_report: selectionReport } : {}),
                    };
                }
                const result = writeChangelog({
                    ...generationOptions,
                    output,
                    mode,
                    check: Boolean(ctx.options["check"]),
                });
                if (result.changed && Boolean(ctx.options["check"])) {
                    throw new PmCliError(`Changelog is out of date: ${result.output}`, EXIT_CODE.GENERIC_FAILURE);
                }
                return {
                    file: result.output,
                    action: result.action,
                    changed: result.changed,
                    item_count: result.itemCount,
                    bytes: result.bytes,
                    check: Boolean(ctx.options["check"]),
                    ...(selectionReport ? { selection_report: selectionReport } : {}),
                };
            },
        });
        // -----------------------------------------------------------------------
        // Exporter: `pm changelog export` — native export pipeline.
        // Reuses the same generation core as `changelog generate` (whose default
        // output is intentionally left byte-identical). Adds --format md|json and a
        // --release-notes concise mode. Does NOT write CHANGELOG.md unless --output
        // is given, so it is side-effect free by default.
        // -----------------------------------------------------------------------
        const changelogExportMetadata = {
            description: "Export changelog or release notes through the pm import/export pipeline.",
            intent: "export changelog release notes as markdown or json",
            examples: [
                "pm changelog export",
                "pm changelog export --format json",
                "pm changelog export --release-notes --since-previous-tag --until-release-tag",
                "pm changelog export --output RELEASE_NOTES.md --release-version-from-package",
            ],
            flags: [
                { long: "--format", value_name: "md|json", description: "Export format (default: md)" },
                { long: "--output", value_name: "file", description: "Write output to a file instead of stdout" },
                { long: "--release-notes", description: "Use a concise release-notes title and output shape" },
                { long: "--title", value_name: "text", description: "Output title (default: Changelog or Release Notes)" },
                { long: "--release-version", value_name: "version", description: "Release/version heading (default: Unreleased)" },
                { long: "--release-version-from-package", description: "Read release/version heading from nearest package.json" },
                { long: "--date", value_name: "date", description: "Release date (default: resolved tag date when available, otherwise today)" },
                { long: "--since", value_name: "date", description: "Include items changed on or after this date" },
                { long: "--since-previous-tag", description: "Derive --since from the previous git tag" },
                { long: "--until", value_name: "date", description: "Include items changed on or before this date" },
                { long: "--until-release-tag", description: "Derive --until from the current release tag when it exists" },
                { long: "--status", value_name: "list", description: "Comma-separated statuses (default: closed)" },
                { long: "--group-by", value_name: "mode", description: "version, release, or milestone (default: version)" },
                { long: "--include-empty", description: "Emit an empty release section when no items match" },
                { long: "--include-links", description: "Include item URLs in generated entries (default: false)" },
                { long: "--include-metadata", description: "Append compact item metadata (type/status/priority/release/milestone) to each entry" },
                { long: "--item-url-base", value_name: "url", description: "Make item IDs clickable links to .toon files under the base URL" },
            ],
        };
        const registerExporterWithMetadata = api.registerExporter;
        registerExporterWithMetadata("changelog", async (ctx) => {
            const format = (stringOption(ctx.options, "format", "format") ?? "md").toLowerCase();
            if (format !== "md" && format !== "json") {
                throw new PmCliError("--format must be 'md' or 'json'", EXIT_CODE.USAGE);
            }
            const groupByOption = stringOption(ctx.options, "group-by", "groupBy") ?? "version";
            if (groupByOption !== "version" && groupByOption !== "release" && groupByOption !== "milestone") {
                throw new PmCliError("--group-by must be 'version', 'release', or 'milestone'", EXIT_CODE.USAGE);
            }
            const releaseNotes = booleanOption(ctx.options, "release-notes", "releaseNotes");
            const releaseVersion = stringOption(ctx.options, "release-version", "releaseVersion");
            const sinceOption = stringOption(ctx.options, "since", "since");
            const untilOption = stringOption(ctx.options, "until", "until");
            const statuses = ctx.options["status"]
                ?.split(",").map((s) => s.trim()).filter(Boolean);
            const releaseContext = resolveReleaseContext({
                cwd: ctx.pm_root,
                version: releaseVersion,
                versionFromPackage: booleanOption(ctx.options, "release-version-from-package", "releaseVersionFromPackage"),
                since: sinceOption,
                sincePreviousTag: booleanOption(ctx.options, "since-previous-tag", "sincePreviousTag"),
                until: untilOption,
                untilReleaseTag: booleanOption(ctx.options, "until-release-tag", "untilReleaseTag"),
            });
            const items = await listAllFrontMatter(ctx.pm_root);
            const generated = createChangelog({
                items,
                title: stringOption(ctx.options, "title", "title") ?? (releaseNotes ? "Release Notes" : undefined),
                version: releaseContext.version,
                date: stringOption(ctx.options, "date", "date") ?? releaseContext.date,
                since: releaseContext.since,
                until: releaseContext.until,
                includeStatuses: statuses,
                groupBy: groupByOption,
                includeEmpty: booleanOption(ctx.options, "include-empty", "includeEmpty"),
                includeLinks: booleanOption(ctx.options, "include-links", "includeLinks"),
                includeMetadata: booleanOption(ctx.options, "include-metadata", "includeMetadata"),
                itemUrlBase: stringOption(ctx.options, "item-url-base", "itemUrlBase"),
            });
            const outputPath = stringOption(ctx.options, "output", "output");
            if (format === "json") {
                const payload = {
                    version: releaseContext.version ?? "Unreleased",
                    item_count: generated.itemCount,
                    group_by: groupByOption,
                    markdown: generated.markdown,
                };
                if (outputPath) {
                    writeFileSync(resolve(outputPath), JSON.stringify(payload, null, 2) + "\n", "utf-8");
                    return { file: outputPath, format: "json", item_count: generated.itemCount };
                }
                return payload;
            }
            if (outputPath) {
                writeFileSync(resolve(outputPath), generated.markdown.endsWith("\n") ? generated.markdown : generated.markdown + "\n", "utf-8");
                return { file: outputPath, format: "markdown", item_count: generated.itemCount };
            }
            return { changelog: generated.markdown, format: "markdown", item_count: generated.itemCount };
        }, changelogExportMetadata);
        if (api.registerExporter.length < 3 && typeof api.registerFlags === "function") {
            api.registerFlags("changelog export", changelogExportMetadata.flags);
        }
    },
});
/**
 * Best-effort enrichment of front-matter items with their on-disk body, used so
 * `--body-preview` renders real body content in the extension path (GH #27).
 * `listAllFrontMatter` omits bodies, so each item is re-read via the public SDK
 * locate/read helpers. Items already carrying a body are skipped, and any
 * per-item read failure is swallowed so changelog generation never breaks.
 */
async function enrichItemBodies(pmRoot, items) {
    let typeToFolder;
    let idPrefix;
    let format;
    try {
        const settings = await readSettings(pmRoot);
        typeToFolder = resolveItemTypeRegistry(settings).type_to_folder;
        idPrefix = settings.id_prefix;
        format = settings.item_format;
    }
    catch {
        return; // cannot resolve settings/registry → leave front matter as-is
    }
    const loadBody = async (item) => {
        if (!item.id)
            return;
        if (typeof item.body === "string" && item.body.trim() !== "")
            return;
        try {
            const located = await locateItem(pmRoot, item.id, idPrefix, format, typeToFolder);
            if (!located)
                return;
            const { document } = await readLocatedItem(located);
            if (typeof document.body === "string" && document.body.trim() !== "") {
                item.body = document.body;
            }
        }
        catch {
            // best-effort: a single unreadable item must not fail generation
        }
    };
    // Bound concurrency so a large workspace can't exhaust file descriptors
    // (EMFILE) by issuing one locate+read per item all at once.
    const CONCURRENCY_LIMIT = 16;
    for (let i = 0; i < items.length; i += CONCURRENCY_LIMIT) {
        await Promise.all(items.slice(i, i + CONCURRENCY_LIMIT).map(loadBody));
    }
}
function stringOption(options, kebabKey, camelKey) {
    const value = options[kebabKey] ?? options[camelKey];
    return typeof value === "string" ? value : undefined;
}
function booleanOption(options, kebabKey, camelKey) {
    return Boolean(options[kebabKey] ?? options[camelKey]);
}
function parseLimitOption(options) {
    const raw = options["limit"];
    if (raw === undefined || raw === null || raw === "")
        return undefined;
    const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new PmCliError("--limit must be a positive integer", EXIT_CODE.USAGE);
    }
    return parsed;
}
function parseBodyPreviewOption(options) {
    const raw = options["body-preview"] ?? options["bodyPreview"];
    if (raw === undefined || raw === null || raw === "")
        return undefined;
    const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new PmCliError("--body-preview must be a positive integer", EXIT_CODE.USAGE);
    }
    return parsed;
}
//# sourceMappingURL=extension.js.map