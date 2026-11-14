/**
 * @module core/extensions/mutation-actor
 *
 * Resolves the read-only actor block that transactional mutation guards
 * receive (GH-1719). Every field comes from the resolvers the history writer
 * uses for the same author, so a guard judges exactly the identity that the
 * mutation's history entry records and no host can substitute a placeholder.
 */
import {
  resolveClaimPrincipal,
  resolveHistoryAgentIdentity,
  resolveHistoryAuthorSource,
} from "../shared/author.js";
import type { MutationActor, MutationActorAgent } from "./extension-types.js";

/**
 * Build the frozen actor a mutation performed by `author` is attributed to.
 * The author, its source and the agent provenance match the history entry the
 * same mutation appends; `principal` is the ownership identity the claim check
 * compares with an item's stored `claim_principal`.
 */
export function resolveMutationActor(author: string): Readonly<MutationActor> {
  const identity = resolveHistoryAgentIdentity(author);
  const agent: MutationActorAgent = {
    ...(identity.harness === undefined ? {} : { harness: identity.harness }),
    ...(identity.model === undefined ? {} : { model: identity.model }),
    ...(identity.model_source === undefined ? {} : { model_source: identity.model_source }),
    ...(identity.instance === undefined ? {} : { instance: identity.instance }),
  };
  return Object.freeze({
    author,
    author_source: resolveHistoryAuthorSource(author),
    principal: resolveClaimPrincipal(author),
    ...(Object.keys(agent).length === 0 ? {} : { agent: Object.freeze(agent) }),
  });
}

/** Copy an actor for one guard, so no guard can alter what the next guard or the history writer sees. */
export function cloneMutationActor(actor: Readonly<MutationActor>): Readonly<MutationActor> {
  return Object.freeze({
    author: actor.author,
    author_source: actor.author_source,
    principal: actor.principal,
    ...(actor.agent === undefined ? {} : { agent: Object.freeze({ ...actor.agent }) }),
  });
}
