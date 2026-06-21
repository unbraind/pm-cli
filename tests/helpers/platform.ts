import { it } from "vitest";

export const isPosix = process.platform !== "win32";
export const itOnPosix = isPosix ? it : it.skip;
