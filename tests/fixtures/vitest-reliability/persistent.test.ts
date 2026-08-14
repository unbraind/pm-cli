import { expect, test } from "vitest";

test("persistent assertion remains a failure", () => {
  expect(1).toBe(2);
});
