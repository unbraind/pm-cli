# Startup benchmark runner qualification

Tracked by [pm-bj7rq0](../../.agents/pm/issues/pm-bj7rq0.toon).

The SDK import and CLI transport gates retain their absolute latency and RSS
ratchets. A bare Node control determines whether the runner qualifies independently
of product admission. Both benchmarks bracket their census with post-warmup
controls before and after it; the CLI uses five samples per control. Both use the existing SDK bare-process
budget and its fixed 30 ms scheduler margin.

Successful checks explicitly return `runner_qualification.status=qualified` and
`product_admission=passed`. Failed checks retain the complete measured report,
every product violation, runtime identity, available parallelism, load averages,
and memory observations. `benchmark_runner_unqualified` leaves product admission
`unverified`; it still exits unsuccessfully. A qualified runner with an over-budget
command returns `benchmark_product_budget_exceeded` and failed admission.

Control cost is never subtracted from product measurements. Pressure observations
are diagnostic context and do not prove the cause of a failure. An unchanged base
comparison on the same runtime helps distinguish a new regression from a runner
that cannot qualify; a failed or unavailable comparison cannot certify a pass.
