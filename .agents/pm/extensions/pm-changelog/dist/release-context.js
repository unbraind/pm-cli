import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
export function resolveReleaseContext(options) {
    const cwd = resolve(options.cwd ?? process.cwd());
    const version = options.version ?? (options.versionFromPackage ? readPackageVersion(cwd) : undefined);
    const releaseTag = version ? findExistingTag(cwd, releaseTagCandidates(version)) : undefined;
    const previousTag = options.sincePreviousTag ? findPreviousTag(cwd, releaseTag) : undefined;
    return {
        version,
        releaseTag,
        previousTag,
        since: options.since ?? (previousTag ? gitCommitTimestamp(cwd, previousTag) : undefined),
        until: options.until ?? (options.untilReleaseTag && releaseTag ? gitCommitTimestamp(cwd, releaseTag) : undefined),
    };
}
export function resolveReleaseTagWindows(options = {}) {
    const cwd = resolve(options.cwd ?? process.cwd());
    const tags = listReleaseTags(cwd, options.tagPattern ?? "v*");
    const pending = resolvePendingReleaseTag(options, tags);
    const orderedTags = pending ? [pending, ...tags] : tags;
    if (orderedTags.length === 0)
        return [];
    const windows = [];
    if (options.includeUnreleased !== false) {
        windows.push({
            heading: "Unreleased",
            since: orderedTags[0].timestamp,
            sinceExclusive: true,
        });
    }
    for (let index = 0; index < orderedTags.length; index++) {
        const tag = orderedTags[index];
        const previous = orderedTags[index + 1];
        windows.push({
            heading: `${formatTagVersion(tag.name)} - ${formatDate(tag.timestamp)}`,
            releaseTag: tag.name,
            since: previous?.timestamp,
            sinceExclusive: Boolean(previous),
            until: tag.timestamp,
        });
    }
    return windows;
}
function resolvePendingReleaseTag(options, existingTags) {
    const version = options.pendingVersion?.trim();
    if (!version)
        return undefined;
    const candidates = releaseTagCandidates(version);
    const candidateSet = new Set(candidates);
    if (existingTags.some((tag) => candidateSet.has(tag.name)))
        return undefined;
    const canonical = canonicalPendingTagName(candidates, version);
    const timestamp = normalizeTimestamp(options.pendingTimestamp ?? new Date().toISOString());
    return { name: canonical, timestamp };
}
function canonicalPendingTagName(candidates, fallback) {
    const preferred = candidates.find((candidate) => /^v\d{4}\.\d{2}\.\d{2}/.test(candidate))
        ?? candidates.find((candidate) => candidate.startsWith("v"))
        ?? fallback;
    return preferred;
}
function readPackageVersion(cwd) {
    const packageJsonPath = findPackageJson(cwd);
    if (!packageJsonPath) {
        throw new Error("--release-version-from-package requires a package.json in the current directory or an ancestor");
    }
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
    if (typeof parsed.version !== "string" || parsed.version.trim() === "") {
        throw new Error(`${packageJsonPath} does not contain a valid version field`);
    }
    return parsed.version;
}
function findPackageJson(start) {
    let current = start;
    while (true) {
        const candidate = join(current, "package.json");
        if (existsSync(candidate))
            return candidate;
        const parent = dirname(current);
        if (parent === current)
            return undefined;
        current = parent;
    }
}
function findExistingTag(cwd, candidates) {
    for (const candidate of candidates) {
        const result = runGit(cwd, ["rev-parse", "--verify", "--quiet", `refs/tags/${candidate}`]);
        if (result)
            return candidate;
    }
    return undefined;
}
function releaseTagCandidates(version) {
    const trimmed = version.trim();
    const candidates = [`v${trimmed}`, trimmed];
    const calendar = trimmed.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})(-.+)?$/);
    if (calendar) {
        const [, year, month, day, suffix = ""] = calendar;
        const padded = `${year}.${month.padStart(2, "0")}.${day.padStart(2, "0")}${suffix}`;
        candidates.push(`v${padded}`, padded);
    }
    return Array.from(new Set(candidates));
}
function findPreviousTag(cwd, releaseTag) {
    const ref = releaseTag ? `${releaseTag}^` : "HEAD";
    return runGit(cwd, ["describe", "--tags", "--abbrev=0", ref]);
}
function listReleaseTags(cwd, pattern) {
    const output = runGit(cwd, [
        "tag",
        "--list",
        pattern,
        "--merged",
        "HEAD",
        "--format=%(refname:short)%09%(*committerdate:iso-strict)%09%(committerdate:iso-strict)",
    ]);
    if (!output)
        return [];
    return output
        .split("\n")
        .map(parseTagLine)
        .filter((tag) => Boolean(tag))
        .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
}
function parseTagLine(line) {
    const [name, peeledCommitterDate, directCommitterDate] = line.split("\t");
    const tagName = name?.trim();
    const timestamp = (peeledCommitterDate || directCommitterDate)?.trim();
    if (!tagName || !timestamp)
        return undefined;
    return { name: tagName, timestamp };
}
function gitCommitTimestamp(cwd, ref) {
    const timestamp = runGit(cwd, ["log", "-1", "--format=%cI", ref]);
    if (!timestamp) {
        throw new Error(`Could not resolve git timestamp for ${ref}`);
    }
    return timestamp;
}
function runGit(cwd, args) {
    try {
        const output = execFileSync("git", args, {
            cwd,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        return output || undefined;
    }
    catch {
        return undefined;
    }
}
function formatTagVersion(tag) {
    return tag.replace(/^v/i, "");
}
function formatDate(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime()))
        return timestamp.slice(0, 10);
    return date.toISOString().slice(0, 10);
}
function normalizeTimestamp(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime()))
        return value;
    return date.toISOString();
}
//# sourceMappingURL=release-context.js.map