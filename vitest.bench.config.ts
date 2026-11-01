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
 *
 * Benchmarks use Vitest 5's `bench` test fixture: each group is one `test`
 * that passes its registrations to `bench.compare`. Keep group and benchmark
 * names stable, because CodSpeed keys history by `<file>::<group>::<bench>`.
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
