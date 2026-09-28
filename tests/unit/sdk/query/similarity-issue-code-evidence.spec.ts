import { describe, expect, it } from "vitest";
import {
  prepareSimilarityText,
  scoreItemSimilarity,
} from "../../../../src/sdk/similarity-scoring.js";

describe("issue-code evidence in similarity scoring", () => {
  it("keeps common numbered technical terms out of identity scoring", () => {
    for (const term of [
      "UTF-8",
      "UTF-16",
      "SHA-256",
      "ISO-8859",
      "Match-3",
      "match-10",
      "chart-404",
    ]) {
      expect(
        prepareSimilarityText(`Document ${term} behavior`).issueCodes,
      ).toEqual([]);
    }
  });

  it("keeps complete identifiers with strong title evidence", () => {
    expect(
      scoreItemSimilarity("Fix GH-7 import", "Review gh-7 import"),
    ).toMatchObject({
      reason: "issue_code",
      score: 0.99,
    });
    expect(
      scoreItemSimilarity("TASK-7: improve import", "TASK-7: review export"),
    ).toMatchObject({
      reason: "issue_code",
      score: 0.99,
    });
    expect(scoreItemSimilarity("TASK-7 import", "TASK-7 review")).toMatchObject(
      {
        reason: "issue_code",
        score: 0.99,
      },
    );
    expect(
      scoreItemSimilarity("task-7: improve import", "task-7: review export"),
    ).toMatchObject({
      reason: "issue_code",
      score: 0.99,
    });
    expect(
      scoreItemSimilarity("Fix Gh-672 import", "Review gh-672 regression"),
    ).toMatchObject({
      reason: "issue_code",
      score: 0.99,
    });
    expect(
      scoreItemSimilarity("BD-30-A: import", "BD-30-B: import").reason,
    ).toBe("title_token_jaccard");
    expect(prepareSimilarityText("Review TASK-7 import").issueCodes).toEqual([
      "task-7",
    ]);
    expect(prepareSimilarityText("TASK-7 import").issueCodes).toEqual([
      "task-7",
    ]);
  });
});
