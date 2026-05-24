export interface ReleaseContextOptions {
    cwd?: string;
    version?: string;
    versionFromPackage?: boolean;
    since?: string;
    sincePreviousTag?: boolean;
    until?: string;
    untilReleaseTag?: boolean;
}
export interface ReleaseContext {
    version?: string;
    since?: string;
    until?: string;
    releaseTag?: string;
    previousTag?: string;
}
export declare function resolveReleaseContext(options: ReleaseContextOptions): ReleaseContext;
//# sourceMappingURL=release-context.d.ts.map