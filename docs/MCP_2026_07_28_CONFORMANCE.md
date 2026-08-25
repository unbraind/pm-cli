# MCP 2026-07-28 Conformance Matrix

Tracker: [pm-55yf1t](../.agents/pm/tasks/pm-55yf1t.toon). The official
2026-07-28 schema and key-changes document are normative; this matrix assigns
every revision-level change to one canonical pm owner and records executable
evidence or an explicit open obligation.

| Requirement family | Canonical owner | Current disposition | Executable evidence |
| --- | --- | --- | --- |
| Stateless per-request version, client capabilities, and identity | [pm-vae5ec](../.agents/pm/features/pm-vae5ec.toon) | Implemented | `tests/unit/sdk/mcp/protocol.spec.ts`, `tests/integration/mcp-stateless-protocol.spec.ts` |
| Mandatory `server/discover`, deterministic capabilities and identity | [pm-vae5ec](../.agents/pm/features/pm-vae5ec.toon) | Implemented | direct SDK/server tests plus plugin and release real-process probes |
| Unsupported version `-32022` | [pm-vae5ec](../.agents/pm/features/pm-vae5ec.toon) | Implemented | SDK and server negative controls |
| Header mismatch `-32020` and missing capability `-32021` | [pm-vae5ec](../.agents/pm/features/pm-vae5ec.toon) | SDK primitive implemented; HTTP binding open | SDK negative controls; HTTP proof remains under `pm-3zh9s4` |
| Required result `resultType`; legacy omission means complete only at compatibility boundary | [pm-vae5ec](../.agents/pm/features/pm-vae5ec.toon) | Implemented for modern pm results | SDK unit and modern direct-server tests |
| No modern initialize, initialized notification, ping, or protocol session | [pm-sqvshj](../.agents/pm/decisions/pm-sqvshj.toon) | Implemented with bounded legacy stdio adapter | modern removed-method and legacy handshake tests |
| MRTR `input_required`, retry state, and reverse-request removal | [pm-rz9gep](../.agents/pm/features/pm-rz9gep.toon) | Open | owner acceptance criteria define positive, replay, consent, and expiry controls |
| `subscriptions/listen`, request-scoped streams, no SSE resumability | [pm-v7e337](../.agents/pm/features/pm-v7e337.toon) | Open | owner acceptance criteria define stdio/HTTP parity and disconnect controls |
| Official `io.modelcontextprotocol/tasks` extension | [pm-rzs24j](../.agents/pm/features/pm-rzs24j.toon) | Open | owner acceptance criteria define durable handles and `tasks/get`/`tasks/update` |
| Cacheable list/read results, deterministic tools, JSON Schema 2020-12, any JSON structured content | [pm-hv1x1x](../.agents/pm/features/pm-hv1x1x.toon) | Discovery cache contract implemented; remaining surfaces open | discovery tests; server-surface suite remains owned by feature |
| Issuer-bound authorization, client metadata documents, consent, headers, OpenTelemetry | [pm-3zh9s4](../.agents/pm/features/pm-3zh9s4.toon) | Open | owner acceptance criteria define issuer/header/trace adversarial cases |
| Core extension negotiation and official extension fallback | [pm-pznhee](../.agents/pm/features/pm-pznhee.toon) | Open | owner acceptance criteria and release matrix |
| Skills over MCP | [pm-8nzivt](../.agents/pm/features/pm-8nzivt.toon) | Open | owner acceptance criteria define capability and token-budget proof |
| Deprecated Roots, Sampling, Logging, HTTP+SSE, `includeContext`, dynamic registration | [pm-vzcisw](../.agents/pm/chores/pm-vzcisw.toon) | Explicit bounded migration | decision table and owner migration tests |
| Official schema, real stdio/HTTP, packed/published, npx/bunx, negative controls | [pm-55yf1t](../.agents/pm/tasks/pm-55yf1t.toon) | Foundation implemented; remains open until every owner above closes | SDK/server suites, plugin smokes, published-release verifier |

The gate remains intentionally incomplete while any row says `Open`. Provider
silence, a successful legacy initialize, or source-only unit coverage cannot
promote such a row. Completion requires the owner's positive and negative
tests plus exact packed and published consumer proof.
