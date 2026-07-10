#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stdin } from "node:process";
import { buildChangelogDocument, createChangelog, createChangelogSummary, explainChangelogSelection, formatSummaryLine, mergeChangelog, parsePmItemsJson, readPmItems, suggestSemver, writeChangelog, } from "./generator.js";
import { resolveReleaseContext, resolveReleaseTagWindows } from "./release-context.js";
// Compatibility aliases for value-taking options. Kept intentionally small and
// explicit so default behavior remains stable.
const OPTION_ALIASES = {
    "--release-version": "--version",
};
const VALUE_OPTIONS = new Set([
    "-i",
    "-o",
    "--body-preview",
    "--date",
    "--format",
    "--group-by",
    "--input",
    "--item-url-base",
    "--limit",
    "--mode",
    "--output",
    "--pm-arg",
    "--pm-bin",
    "--pm-cwd",
    "--pm-root",
    "--release-tag-pattern",
    "--release-version",
    "--section-by",
    "--since",
    "--since-version",
    "--status",
    "--statuses",
    "--title",
    "--until",
    "--version",
]);
const KNOWN_OPTIONS = [
    "-h",
    "-i",
    "-o",
    "--all-release-tags",
    "--body-preview",
    "--breaking-changes",
    "--changelog-json",
    "--check",
    "--conventional",
    "--contributors",
    "--date",
    "--emoji-prefix",
    "--explain",
    "--format",
    "--github-output",
    "--github-step-summary",
    "--group-by",
    "--help",
    "--include-empty",
    "--include-links",
    "--include-metadata",
    "--input",
    "--item-url-base",
    "--json",
    "--limit",
    "--mode",
    "--no-links",
    "--output",
    "--pm-arg",
    "--pm-bin",
    "--pm-cwd",
    "--pm-root",
    "--release-tag-pattern",
    "--release-version",
    "--release-version-from-package",
    "--section-by",
    "--set-output",
    "--since",
    "--since-previous-tag",
    "--since-version",
    "--status",
    "--statuses",
    "--stdin",
    "--stdout",
    "--summary",
    "--suggest-semver",
    "--title",
    "--until",
    "--until-release-tag",
    "--version",
];
async function main() {
    const options = parseArgs(process.argv.slice(2));
    applyReleaseContext(options);
    const items = await loadItems(options);
    const outputPath = resolve(options.output);
    const generationOptions = buildGenerationOptions(options, items);
    const selectionReport = options.explain ? explainChangelogSelection(generationOptions) : undefined;
    // OPT-IN (`--format json` without `--summary`): alias for the structured
    // `--changelog-json` document, giving agents a single standard `--format`
    // flag for machine-readable output. `--summary --format json` is handled
    // separately below, and `--suggest-semver` keeps its dedicated JSON shape
    // (the semver analysis) instead of being aliased to the full document.
    if (options.format === "json" && !options.summary && !options.changelogJson && !options.suggestSemver) {
        options.changelogJson = true;
    }
    // OPT-IN (`--summary`): compact one-line-per-change output for quick agent
    // scanning. Emits flat entries (release heading + category + item) instead
    // of full markdown. `--format json` switches to a JSON array; the default
    // `--format md` renders bracketed text lines (`[version] category: title (id)`).
    // Never writes a file.
    if (options.summary) {
        const entries = createChangelogSummary(generationOptions);
        if (options.format === "json") {
            const payload = selectionReport
                ? { entries, selection_report: selectionReport }
                : entries;
            process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
        }
        else {
            for (const entry of entries) {
                process.stdout.write(formatSummaryLine(entry) + "\n");
            }
            if (selectionReport)
                writeSelectionReport(selectionReport);
        }
        return;
    }
    // OPT-IN (`--changelog-json`): emit the full structured changelog document to
    // stdout and exit, leaving every other mode and CHANGELOG.md untouched.
    if (options.changelogJson) {
        const document = buildChangelogDocument(generationOptions);
        const payload = selectionReport
            ? { ...document, selection_report: selectionReport }
            : document;
        process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
        return;
    }
    // OPT-IN (`--suggest-semver`) without `--changelog-json`: emit only the
    // semver analysis as JSON to stdout and exit. Never writes CHANGELOG.md and
    // never touches default markdown.
    if (options.suggestSemver) {
        const suggestion = suggestSemver(generationOptions);
        const payload = selectionReport
            ? { ...suggestion, selection_report: selectionReport }
            : suggestion;
        process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
        return;
    }
    if (!options.stdout) {
        const result = writeChangelog({
            ...generationOptions,
            output: outputPath,
            mode: options.mode,
            check: options.check,
        });
        const summary = buildSummary(options, result, outputPath, selectionReport);
        if (options.githubOutput)
            writeGitHubOutput(summary);
        if (options.githubStepSummary)
            writeGitHubStepSummary(result.markdown);
        if (options.json) {
            process.stdout.write(JSON.stringify(summary) + "\n");
        }
        else if (options.check) {
            console.error(result.changed ? `Changelog is out of date: ${outputPath}` : `Changelog is up to date: ${outputPath}`);
        }
        else {
            console.error(`Wrote ${outputPath}`);
        }
        if (!options.json && selectionReport) {
            writeSelectionReport(selectionReport);
        }
        if (options.check && result.changed)
            process.exit(1);
        return;
    }
    const generated = createChangelog(generationOptions);
    const existing = options.mode === "prepend" && existsSync(outputPath)
        ? readFileSync(outputPath, "utf-8")
        : undefined;
    const merged = options.mode === "prepend"
        ? mergeChangelog(existing, generated.markdown, { title: options.title })
        : { markdown: generated.markdown, action: "replaced", changed: true };
    if (options.stdout) {
        if (options.json) {
            const summary = buildSummary(options, {
                output: outputPath,
                markdown: merged.markdown,
                action: merged.action,
                changed: merged.changed,
                itemCount: generated.itemCount,
                bytes: Buffer.byteLength(merged.markdown, "utf-8"),
            }, outputPath, selectionReport);
            if (options.githubOutput)
                writeGitHubOutput(summary);
            if (options.githubStepSummary)
                writeGitHubStepSummary(merged.markdown);
            process.stdout.write(JSON.stringify(summary) + "\n");
            return;
        }
        if (selectionReport) {
            writeSelectionReport(selectionReport);
        }
        if (options.githubStepSummary)
            writeGitHubStepSummary(merged.markdown);
        process.stdout.write(merged.markdown);
        return;
    }
}
function parseArgs(args) {
    const normalizedArgs = normalizeArgs(args);
    const options = {
        output: "CHANGELOG.md",
        stdout: false,
        json: false,
        stdin: false,
        pmArgs: [],
        groupBy: "version",
        sectionBy: "category",
        summary: false,
        format: "md",
        conventional: false,
        contributors: false,
        breakingChanges: false,
        suggestSemver: false,
        emojiPrefix: false,
        includeMetadata: false,
        changelogJson: false,
        includeEmpty: false,
        includeLinks: false,
        mode: "replace",
        check: false,
        explain: false,
        githubOutput: false,
        githubStepSummary: false,
        versionFromPackage: false,
        sincePreviousTag: false,
        untilReleaseTag: false,
        allReleaseTags: false,
        releaseTagPattern: "v*",
    };
    for (let i = 0; i < normalizedArgs.length; i++) {
        const rawArg = normalizedArgs[i];
        const arg = resolveOptionAlias(rawArg);
        switch (arg) {
            case "--help":
            case "-h":
                printHelp();
                process.exit(0);
            case "--output":
            case "-o":
                options.output = requireValue(normalizedArgs, ++i, rawArg);
                break;
            case "--stdout":
                options.stdout = true;
                break;
            case "--json":
                options.json = true;
                break;
            case "--check":
                options.check = true;
                break;
            case "--explain":
                options.explain = true;
                break;
            case "--github-output":
            case "--set-output":
                options.githubOutput = true;
                break;
            case "--github-step-summary":
                options.githubStepSummary = true;
                break;
            case "--input":
            case "-i":
                options.input = requireValue(normalizedArgs, ++i, rawArg);
                break;
            case "--stdin":
                options.stdin = true;
                break;
            case "--pm-root":
                options.pmRoot = requireValue(normalizedArgs, ++i, rawArg);
                break;
            case "--pm-bin":
                options.pmBin = requireValue(normalizedArgs, ++i, rawArg);
                break;
            case "--pm-arg":
                options.pmArgs.push(requireAnyValue(normalizedArgs, ++i, rawArg));
                break;
            case "--pm-cwd":
                options.pmCwd = requireValue(normalizedArgs, ++i, rawArg);
                break;
            case "--title":
                options.title = requireValue(normalizedArgs, ++i, rawArg);
                break;
            case "--version":
                options.version = requireValue(normalizedArgs, ++i, rawArg);
                break;
            case "--release-version-from-package":
                options.versionFromPackage = true;
                break;
            case "--date":
                options.date = requireValue(normalizedArgs, ++i, rawArg);
                break;
            case "--since":
                options.since = requireValue(normalizedArgs, ++i, rawArg);
                break;
            case "--since-previous-tag":
                options.sincePreviousTag = true;
                break;
            case "--until":
                options.until = requireValue(normalizedArgs, ++i, rawArg);
                break;
            case "--until-release-tag":
                options.untilReleaseTag = true;
                break;
            case "--all-release-tags":
                options.allReleaseTags = true;
                break;
            case "--release-tag-pattern":
                options.releaseTagPattern = requireValue(normalizedArgs, ++i, rawArg);
                break;
            case "--status":
            case "--statuses":
                options.statuses = requireValue(normalizedArgs, ++i, rawArg)
                    .split(",")
                    .map((status) => status.trim())
                    .filter(Boolean);
                break;
            case "--group-by":
                options.groupBy = parseGroupBy(requireValue(normalizedArgs, ++i, rawArg));
                break;
            case "--section-by":
                options.sectionBy = parseSectionBy(requireValue(normalizedArgs, ++i, rawArg));
                break;
            case "--summary":
                options.summary = true;
                break;
            case "--format":
                options.format = parseFormat(requireValue(normalizedArgs, ++i, rawArg));
                break;
            case "--conventional":
                options.conventional = true;
                break;
            case "--contributors":
                options.contributors = true;
                break;
            case "--breaking-changes":
                options.breakingChanges = true;
                break;
            case "--suggest-semver":
                options.suggestSemver = true;
                break;
            case "--body-preview":
                options.bodyPreview = parseBodyPreview(requireValue(normalizedArgs, ++i, rawArg));
                break;
            case "--emoji-prefix":
                options.emojiPrefix = true;
                break;
            case "--include-metadata":
                options.includeMetadata = true;
                break;
            case "--changelog-json":
                options.changelogJson = true;
                break;
            case "--limit":
                options.limit = parseLimit(requireValue(normalizedArgs, ++i, rawArg));
                break;
            case "--since-version":
                options.sinceVersion = requireValue(normalizedArgs, ++i, rawArg);
                break;
            case "--mode":
                options.mode = parseMode(requireValue(normalizedArgs, ++i, rawArg));
                break;
            case "--include-empty":
                options.includeEmpty = true;
                break;
            case "--include-links":
                options.includeLinks = true;
                break;
            case "--no-links":
                options.includeLinks = false;
                break;
            case "--item-url-base":
                options.itemUrlBase = requireValue(normalizedArgs, ++i, rawArg);
                break;
            default:
                throw unknownOptionError(rawArg);
        }
    }
    return options;
}
function normalizeArgs(args) {
    const normalized = [];
    for (const arg of args) {
        const equalsIndex = arg.indexOf("=");
        if (equalsIndex <= 0) {
            normalized.push(arg);
            continue;
        }
        const flag = arg.slice(0, equalsIndex);
        if (!VALUE_OPTIONS.has(flag)) {
            normalized.push(arg);
            continue;
        }
        normalized.push(flag, arg.slice(equalsIndex + 1));
    }
    return normalized;
}
function resolveOptionAlias(arg) {
    return OPTION_ALIASES[arg] ?? arg;
}
function unknownOptionError(arg) {
    const token = optionToken(arg);
    const suggestion = suggestOption(token);
    const hint = suggestion ? ` Did you mean '${suggestion}'?` : "";
    return new Error(`Unknown option: ${arg}.${hint} Run --help for usage.`);
}
function optionToken(arg) {
    if (!arg.startsWith("-"))
        return arg;
    const equalsIndex = arg.indexOf("=");
    return equalsIndex > 0 ? arg.slice(0, equalsIndex) : arg;
}
function suggestOption(arg) {
    let best;
    for (const candidate of KNOWN_OPTIONS) {
        const distance = editDistance(arg, candidate);
        // Keep suggestions conservative: close edits only.
        const threshold = Math.max(2, Math.floor(candidate.length * 0.34));
        if (distance > threshold)
            continue;
        if (!best || distance < best.distance) {
            best = { option: candidate, distance };
            continue;
        }
        if (distance === best.distance && candidate.length < best.option.length) {
            best = { option: candidate, distance };
        }
    }
    return best?.option;
}
function editDistance(left, right) {
    if (left === right)
        return 0;
    const rows = left.length + 1;
    const cols = right.length + 1;
    const matrix = Array.from({ length: rows }, () => new Array(cols).fill(0));
    for (let i = 0; i < rows; i++)
        matrix[i][0] = i;
    for (let j = 0; j < cols; j++)
        matrix[0][j] = j;
    for (let i = 1; i < rows; i++) {
        for (let j = 1; j < cols; j++) {
            const substitutionCost = left[i - 1] === right[j - 1] ? 0 : 1;
            matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + substitutionCost);
        }
    }
    return matrix[rows - 1][cols - 1];
}
function applyReleaseContext(options) {
    if (options.allReleaseTags) {
        const cwd = options.pmCwd ? resolve(options.pmCwd) : process.cwd();
        if (options.versionFromPackage && !options.version) {
            const context = resolveReleaseContext({
                cwd,
                versionFromPackage: true,
            });
            options.version = context.version;
        }
        options.releaseWindows = resolveReleaseTagWindows({
            cwd,
            tagPattern: options.releaseTagPattern,
            pendingVersion: options.version,
            pendingTimestamp: options.until ?? options.date,
        });
        return;
    }
    if (!options.version && !options.versionFromPackage && !options.sincePreviousTag && !options.untilReleaseTag)
        return;
    const context = resolveReleaseContext({
        cwd: options.pmCwd ? resolve(options.pmCwd) : process.cwd(),
        version: options.version,
        versionFromPackage: options.versionFromPackage,
        since: options.since,
        sincePreviousTag: options.sincePreviousTag,
        until: options.until,
        untilReleaseTag: options.untilReleaseTag,
    });
    options.version = context.version;
    options.date = options.date ?? context.date;
    options.since = context.since;
    options.until = context.until;
}
async function loadItems(options) {
    if (options.stdin) {
        return parsePmItemsJson(await readStdin());
    }
    if (options.input) {
        return parsePmItemsJson(readFileSync(resolve(options.input), "utf-8"));
    }
    return readPmItems({
        pmRoot: options.pmRoot,
        pmBin: options.pmBin,
        pmArgs: options.pmArgs,
        cwd: options.pmCwd ? resolve(options.pmCwd) : undefined,
        // Only request bodies when --body-preview needs them; otherwise keep the
        // lighter default list payload (GH #27).
        includeBody: options.bodyPreview !== undefined && options.bodyPreview > 0,
    });
}
function readStdin() {
    return new Promise((resolvePromise, reject) => {
        let data = "";
        stdin.setEncoding("utf-8");
        stdin.on("data", (chunk) => {
            data += chunk;
        });
        stdin.on("end", () => resolvePromise(data));
        stdin.on("error", reject);
    });
}
function parseGroupBy(value) {
    if (value === "version" || value === "release" || value === "milestone")
        return value;
    throw new Error("--group-by must be 'version', 'release', or 'milestone'");
}
function parseSectionBy(value) {
    if (value === "category" || value === "type" || value === "status" || value === "label")
        return value;
    throw new Error("--section-by must be 'category', 'type', 'status', or 'label'");
}
function parseLimit(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error("--limit must be a positive integer");
    }
    return parsed;
}
function parseBodyPreview(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error("--body-preview must be a positive integer");
    }
    return parsed;
}
function parseMode(value) {
    if (value === "replace" || value === "prepend")
        return value;
    throw new Error("--mode must be 'replace' or 'prepend'");
}
function parseFormat(value) {
    const normalized = value.trim().toLowerCase();
    if (normalized === "md" || normalized === "markdown")
        return "md";
    if (normalized === "json")
        return "json";
    throw new Error("--format must be 'md' or 'json'");
}
function buildGenerationOptions(options, items) {
    return {
        items,
        title: options.title,
        version: options.version,
        date: options.date,
        since: options.since,
        until: options.until,
        releaseWindows: options.releaseWindows,
        includeStatuses: options.statuses,
        groupBy: options.groupBy,
        sectionBy: options.sectionBy,
        conventional: options.conventional,
        contributors: options.contributors,
        limit: options.limit,
        sinceVersion: options.sinceVersion,
        breakingChanges: options.breakingChanges,
        bodyPreview: options.bodyPreview,
        emojiPrefix: options.emojiPrefix,
        includeMetadata: options.includeMetadata,
        suggestSemver: options.suggestSemver,
        includeEmpty: options.includeEmpty,
        includeLinks: options.includeLinks,
        itemUrlBase: options.itemUrlBase,
    };
}
function buildSummary(options, result, output = result.output, selectionReport) {
    const summary = {
        output,
        mode: options.mode,
        action: result.action,
        changed: result.changed,
        itemCount: result.itemCount,
        bytes: result.bytes,
        check: options.check,
        markdown: options.stdout ? result.markdown : undefined,
    };
    if (selectionReport)
        summary.selection_report = selectionReport;
    return summary;
}
function writeSelectionReport(report) {
    const excluded = report.excluded_counts;
    console.error("Selection report:"
        + ` input=${report.stage_counts.input}`
        + ` visible=${report.stage_counts.visible_items}`
        + ` excluded(title=${excluded.missing_title},status=${excluded.status},time=${excluded.time_window},release_window=${excluded.release_window},visibility=${excluded.hidden_by_visibility})`);
    for (const hint of report.hints) {
        console.error(`Hint: ${hint}`);
    }
}
function writeGitHubOutput(summary) {
    const githubOutput = process.env.GITHUB_OUTPUT;
    if (!githubOutput) {
        throw new Error("--github-output requires the GITHUB_OUTPUT environment variable");
    }
    const lines = [
        `output=${String(summary.output ?? "")}`,
        `mode=${String(summary.mode ?? "")}`,
        `action=${String(summary.action ?? "")}`,
        `changed=${String(summary.changed ?? "")}`,
        `item_count=${String(summary.itemCount ?? "")}`,
        `bytes=${String(summary.bytes ?? "")}`,
    ];
    appendFileSync(githubOutput, `${lines.join("\n")}\n`, "utf-8");
}
function writeGitHubStepSummary(markdown) {
    const githubStepSummary = process.env.GITHUB_STEP_SUMMARY;
    if (!githubStepSummary) {
        throw new Error("--github-step-summary requires the GITHUB_STEP_SUMMARY environment variable");
    }
    appendFileSync(githubStepSummary, `${markdown.trimEnd()}\n`, "utf-8");
}
function requireValue(args, index, flag) {
    const value = args[index];
    if (!value || value.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
    }
    return value;
}
function requireAnyValue(args, index, flag) {
    const value = args[index];
    if (!value) {
        throw new Error(`${flag} requires a value`);
    }
    return value;
}
function printHelp() {
    process.stdout.write(`pm-changelog

Generate CHANGELOG.md from pm-cli items.

Usage:
  pm-changelog [options]

Options:
  -o, --output <file>       Write changelog to a file (default: CHANGELOG.md)
      --stdout              Print markdown instead of writing a file
      --json                Print a JSON summary for CI/runners
      --format <md|json>    Output format: md (default) or json for machine-readable output
      --summary             Print a compact one-line-per-change summary (bracketed text or JSON with --format json)
      --check               Do not write; exit 1 when output would change
      --github-output       Write summary fields to $GITHUB_OUTPUT
      --github-step-summary Append generated markdown to $GITHUB_STEP_SUMMARY
  -i, --input <file>        Read pm JSON from a file instead of running pm
      --stdin               Read pm JSON from stdin
      --pm-root <dir>       pm project root for "pm --path <dir> list-all --json"
      --pm-bin <file>       pm executable to run (default: pm)
      --pm-arg <arg>        Extra argument passed before "list-all --json" (repeatable)
      --pm-cwd <dir>        Working directory for running pm
      --title <text>        Changelog title (default: Changelog)
      --version <version>   Version heading (default: Unreleased)
      --release-version <version>
                            Alias for --version (matches pm extension syntax)
      --release-version-from-package
                            Read version heading from nearest package.json
      --date <date>         Release date (default: resolved tag date when available, otherwise today)
      --since <date>        Include items changed on or after this date
      --since-previous-tag  Derive --since from the previous git tag
      --until <date>        Include items changed on or before this date
      --until-release-tag   Derive --until from the current release tag when it exists
      --all-release-tags    Rebuild full history from git release tag windows
      --release-tag-pattern <glob>
                            Git tag glob for --all-release-tags (default: v*)
      --status <list>       Comma-separated statuses (default: closed)
      --group-by <mode>     version, release, or milestone (default: version)
      --section-by <mode>   Within-release grouping: category, type, status, or label (default: category)
      --conventional        Use Conventional-Commits headings (Features/Bug Fixes/...) for category grouping
      --contributors        Append a Contributors list per release from item assignee/author
      --limit <n>           Keep only the most recent N release sections (history modes only)
      --since-version <v>   Keep only releases at or newer than version <v> (history modes only)
      --breaking-changes    Emit a Breaking Changes section listing items detected as breaking
      --suggest-semver      Print a suggested semver bump (major/minor/patch) as JSON; never writes the changelog
      --body-preview <n>    Append the first N chars of each item body to its entry
      --emoji-prefix        Prefix section headings with conventional emoji (Added 🎉, Fixed 🐛, ...)
      --include-metadata    Append compact item metadata to each entry
      --changelog-json      Print the full structured changelog document (releases->sections->items) to stdout
      --explain             Print item-selection diagnostics (counts, exclusions, actionable hints)
      --mode <mode>         replace or prepend existing changelog (default: replace)
      --include-empty       Emit an empty release section when no items match
      --include-links       Include item URLs in generated entries (default: false)
      --item-url-base <url> Make item IDs clickable links: [pmc-abc]({url}/pmc-abc.toon)

Value flags accept both "--flag value" and "--flag=value" forms.
`);
}
main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
});
//# sourceMappingURL=cli.js.map