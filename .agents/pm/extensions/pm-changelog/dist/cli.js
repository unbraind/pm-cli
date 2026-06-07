#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stdin } from "node:process";
import { buildChangelogDocument, createChangelog, mergeChangelog, parsePmItemsJson, readPmItems, suggestSemver, writeChangelog, } from "./generator.js";
import { resolveReleaseContext, resolveReleaseTagWindows } from "./release-context.js";
async function main() {
    const options = parseArgs(process.argv.slice(2));
    applyReleaseContext(options);
    const items = await loadItems(options);
    const outputPath = resolve(options.output);
    // OPT-IN (`--changelog-json`): emit the full structured changelog document to
    // stdout and exit, leaving every other mode and CHANGELOG.md untouched.
    if (options.changelogJson) {
        const document = buildChangelogDocument(buildGenerationOptions(options, items));
        process.stdout.write(JSON.stringify(document, null, 2) + "\n");
        return;
    }
    // OPT-IN (`--suggest-semver`) without `--changelog-json`: emit only the
    // semver analysis as JSON to stdout and exit. Never writes CHANGELOG.md and
    // never touches default markdown.
    if (options.suggestSemver) {
        const suggestion = suggestSemver(buildGenerationOptions(options, items));
        process.stdout.write(JSON.stringify(suggestion, null, 2) + "\n");
        return;
    }
    if (!options.stdout) {
        const result = writeChangelog({
            ...buildGenerationOptions(options, items),
            output: outputPath,
            mode: options.mode,
            check: options.check,
        });
        const summary = buildSummary(options, result, outputPath);
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
        if (options.check && result.changed)
            process.exit(1);
        return;
    }
    const generated = createChangelog(buildGenerationOptions(options, items));
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
            });
            if (options.githubOutput)
                writeGitHubOutput(summary);
            if (options.githubStepSummary)
                writeGitHubStepSummary(merged.markdown);
            process.stdout.write(JSON.stringify(summary) + "\n");
            return;
        }
        if (options.githubStepSummary)
            writeGitHubStepSummary(merged.markdown);
        process.stdout.write(merged.markdown);
        return;
    }
}
function parseArgs(args) {
    const options = {
        output: "CHANGELOG.md",
        stdout: false,
        json: false,
        stdin: false,
        pmArgs: [],
        groupBy: "version",
        sectionBy: "category",
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
        githubOutput: false,
        githubStepSummary: false,
        versionFromPackage: false,
        sincePreviousTag: false,
        untilReleaseTag: false,
        allReleaseTags: false,
        releaseTagPattern: "v*",
    };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        switch (arg) {
            case "--help":
            case "-h":
                printHelp();
                process.exit(0);
            case "--output":
            case "-o":
                options.output = requireValue(args, ++i, arg);
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
            case "--github-output":
            case "--set-output":
                options.githubOutput = true;
                break;
            case "--github-step-summary":
                options.githubStepSummary = true;
                break;
            case "--input":
            case "-i":
                options.input = requireValue(args, ++i, arg);
                break;
            case "--stdin":
                options.stdin = true;
                break;
            case "--pm-root":
                options.pmRoot = requireValue(args, ++i, arg);
                break;
            case "--pm-bin":
                options.pmBin = requireValue(args, ++i, arg);
                break;
            case "--pm-arg":
                options.pmArgs.push(requireAnyValue(args, ++i, arg));
                break;
            case "--pm-cwd":
                options.pmCwd = requireValue(args, ++i, arg);
                break;
            case "--title":
                options.title = requireValue(args, ++i, arg);
                break;
            case "--version":
                options.version = requireValue(args, ++i, arg);
                break;
            case "--release-version-from-package":
                options.versionFromPackage = true;
                break;
            case "--date":
                options.date = requireValue(args, ++i, arg);
                break;
            case "--since":
                options.since = requireValue(args, ++i, arg);
                break;
            case "--since-previous-tag":
                options.sincePreviousTag = true;
                break;
            case "--until":
                options.until = requireValue(args, ++i, arg);
                break;
            case "--until-release-tag":
                options.untilReleaseTag = true;
                break;
            case "--all-release-tags":
                options.allReleaseTags = true;
                break;
            case "--release-tag-pattern":
                options.releaseTagPattern = requireValue(args, ++i, arg);
                break;
            case "--status":
            case "--statuses":
                options.statuses = requireValue(args, ++i, arg)
                    .split(",")
                    .map((status) => status.trim())
                    .filter(Boolean);
                break;
            case "--group-by":
                options.groupBy = parseGroupBy(requireValue(args, ++i, arg));
                break;
            case "--section-by":
                options.sectionBy = parseSectionBy(requireValue(args, ++i, arg));
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
                options.bodyPreview = parseBodyPreview(requireValue(args, ++i, arg));
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
                options.limit = parseLimit(requireValue(args, ++i, arg));
                break;
            case "--since-version":
                options.sinceVersion = requireValue(args, ++i, arg);
                break;
            case "--mode":
                options.mode = parseMode(requireValue(args, ++i, arg));
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
                options.itemUrlBase = requireValue(args, ++i, arg);
                break;
            default:
                throw new Error(`Unknown option: ${arg}`);
        }
    }
    return options;
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
function buildSummary(options, result, output = result.output) {
    return {
        output,
        mode: options.mode,
        action: result.action,
        changed: result.changed,
        itemCount: result.itemCount,
        bytes: result.bytes,
        check: options.check,
        markdown: options.stdout ? result.markdown : undefined,
    };
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
      --mode <mode>         replace or prepend existing changelog (default: replace)
      --include-empty       Emit an empty release section when no items match
      --include-links       Include item URLs in generated entries (default: false)
      --item-url-base <url> Make item IDs clickable links: [pmc-abc]({url}/pmc-abc.toon)
`);
}
main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
});
//# sourceMappingURL=cli.js.map