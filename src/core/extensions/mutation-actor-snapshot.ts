/**
 * @module core/extensions/mutation-actor-snapshot
 *
 * Dependency-free copy of a guard's actor block (GH-1719). It is kept apart
 * from the actor resolver so the hook runtime, which every SDK entrypoint
 * loads, does not pull the author-resolution machinery into its import graph.
 */
import type { MutationActor } from "./extension-types.js";

/** Copy an actor for one guard, so no guard can alter what the next guard or the history writer sees. */
export function cloneMutationActor(actor: Readonly<MutationActor>): Readonly<MutationActor> {
  return Object.freeze({
    author: actor.author,
    author_source: actor.author_source,
    principal: actor.principal,
    ...(actor.agent === undefined ? {} : { agent: Object.freeze({ ...actor.agent }) }),
  });
}
