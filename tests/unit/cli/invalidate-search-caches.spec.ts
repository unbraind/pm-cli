import { describe, expect, it, vi, beforeEach } from "vitest";

// Stub the search-refresh collaborators so invalidateSearchCachesForMutation can
// be exercised without touching real cache artifacts or spawning refresh workers.
const refreshSearchArtifactsForMutation = vi.hoisted(() => vi.fn());
const shouldRunSearchRefreshInForeground = vi.hoisted(() => vi.fn(() => false));
const printError = vi.hoisted(() => vi.fn());

vi.mock("../../../src/core/search/cache.js", () => ({ refreshSearchArtifactsForMutation }));
vi.mock("../../../src/core/search/background-refresh.js", () => ({ shouldRunSearchRefreshInForeground }));
vi.mock("../../../src/core/output/output.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/output/output.js")>();
  return { ...actual, printError };
});

import { invalidateSearchCachesForMutation } from "../../../src/cli/registration-helpers.js";

describe("invalidateSearchCachesForMutation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shouldRunSearchRefreshInForeground.mockReturnValue(false);
  });

  it("refreshes in the background when foreground refresh is not requested", async () => {
    refreshSearchArtifactsForMutation.mockResolvedValue({ warnings: [] });
    await invalidateSearchCachesForMutation({ quiet: false, profile: false }, { id: "pm-1" });
    expect(refreshSearchArtifactsForMutation).toHaveBeenCalledWith(
      expect.any(String),
      ["pm-1"],
      { background: true },
    );
    expect(printError).not.toHaveBeenCalled();
  });

  it("refreshes in the foreground when foreground refresh is requested", async () => {
    shouldRunSearchRefreshInForeground.mockReturnValue(true);
    refreshSearchArtifactsForMutation.mockResolvedValue({ warnings: [] });
    await invalidateSearchCachesForMutation({ quiet: false }, undefined);
    expect(refreshSearchArtifactsForMutation).toHaveBeenCalledWith(
      expect.any(String),
      [],
      { background: false },
    );
  });

  it("emits refresh warnings only when profiling is enabled and warnings exist", async () => {
    refreshSearchArtifactsForMutation.mockResolvedValue({ warnings: ["w1", "w2"] });
    await invalidateSearchCachesForMutation({ quiet: false, profile: true }, { id: "pm-2" });
    expect(printError).toHaveBeenCalledWith("profile:search_refresh_warnings=w1,w2");

    // Profiling on but no warnings: nothing is emitted.
    printError.mockClear();
    refreshSearchArtifactsForMutation.mockResolvedValue({ warnings: [] });
    await invalidateSearchCachesForMutation({ quiet: false, profile: true }, { id: "pm-3" });
    expect(printError).not.toHaveBeenCalled();

    // Warnings present but profiling off: still nothing is emitted.
    printError.mockClear();
    refreshSearchArtifactsForMutation.mockResolvedValue({ warnings: ["w"] });
    await invalidateSearchCachesForMutation({ quiet: false, profile: false }, { id: "pm-4" });
    expect(printError).not.toHaveBeenCalled();
  });
});
