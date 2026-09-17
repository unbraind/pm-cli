import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Select the nearest older published calendar version, including same-day manual ordinals. */
export function selectReleaseControl(candidate, versions) {
  const pattern = /^\d{4}\.\d{1,2}\.\d{1,2}(?:-\d+)?$/u;
  if (!pattern.test(candidate) || !Array.isArray(versions)) throw new Error("Invalid published release version inventory.");
  const ordered = versions.filter((version) => typeof version === "string" && pattern.test(version));
  if (!ordered.includes(candidate)) throw new Error("Candidate is absent from the public registry version inventory.");
  ordered.sort((left, right) => {
    const a = left.split(/[.-]/u).map(Number);
    const b = right.split(/[.-]/u).map(Number);
    for (let index = 0; index < 4; index += 1) {
      const difference = (a[index] ?? 1) - (b[index] ?? 1);
      if (difference !== 0) return difference;
    }
    return 0;
  });
  const previous = ordered[ordered.indexOf(candidate) - 1];
  if (!previous) throw new Error("No previous published release is available as an acceptance control.");
  return previous;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(selectReleaseControl(process.argv[2], JSON.parse(readFileSync(process.argv[3], "utf8"))));
}
