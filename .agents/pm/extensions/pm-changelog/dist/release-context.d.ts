import type { ChangelogReleaseWindow } from "./types.js";
export interface ReleaseContextOptions {
    cwd?: string;
    version?: string;
    versionFromPackage?: boolean;
    since?: string;
    sincePreviousTag?: boolean;
    until?: string;
    untilReleaseTag?: boolean;
}
export interface ReleaseTagHistoryOptions {
    cwd?: string;
    tagPattern?: string;
    includeUnreleased?: boolean;
    pendingVersion?: string;
    pendingTimestamp?: string;
}
export interface ReleaseContext {
    version?: string;
    since?: string;
    until?: string;
    releaseTag?: string;
    previousTag?: string;
}
export declare function resolveReleaseContext(options: ReleaseContextOptions): ReleaseContext;
export declare function resolveReleaseTagWindows(options?: ReleaseTagHistoryOptions): ChangelogReleaseWindow[];
//# sourceMappingURL=release-context.d.ts.map