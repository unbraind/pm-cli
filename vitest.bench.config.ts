import codspeedPlugin from "@codspeed/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * Dedicated Vitest configuration for CodSpeed performance benchmarks.
 *
 * This config is intentionally separate from {@link ./vitest.config.ts}: the
 * main test config carries the 100% coverage thresholds, JUnit/lcov reporters,
 * and script-shebang transform used by the correctness suite. Benchmarks have
 * none of those concerns, so keeping them apart avoids the coverage gate ever
 * treating benchmark files as production code and keeps `pnpm test` untouched.
 *
 * The `@codspeed/vitest-plugin` is a no-op when run outside the CodSpeed
 * instrumentation environment, so `vitest bench --config vitest.bench.config.ts`
 * works locally exactly like a normal Vitest bench run and only switches to
 * instrumented measurement when executed under `codspeed run`.
 */
export default defineConfig({
  plugins: [codspeedPlugin()],
  test: {
    include: ["benchmarks/**/*.bench.ts"],
    benchmark: {
      include: ["benchmarks/**/*.bench.ts"],
    },
  },
});
