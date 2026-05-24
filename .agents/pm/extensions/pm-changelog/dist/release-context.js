import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
export function resolveReleaseContext(options) {
    const cwd = resolve(options.cwd ?? process.cwd());
    const version = options.version ?? (options.versionFromPackage ? readPackageVersion(cwd) : undefined);
    const releaseTag = version ? findExistingTag(cwd, [`v${version}`, version]) : undefined;
    const previousTag = options.sincePreviousTag ? findPreviousTag(cwd, releaseTag) : undefined;
    return {
        version,
        releaseTag,
        previousTag,
        since: options.since ?? (previousTag ? gitCommitTimestamp(cwd, previousTag) : undefined),
        until: options.until ?? (options.untilReleaseTag && releaseTag ? gitCommitTimestamp(cwd, releaseTag) : undefined),
    };
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
function findPreviousTag(cwd, releaseTag) {
    const ref = releaseTag ? `${releaseTag}^` : "HEAD";
    return runGit(cwd, ["describe", "--tags", "--abbrev=0", ref]);
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
//# sourceMappingURL=release-context.js.map