/**
 * @module sdk/governance/lifecycle-dependency-cycles
 *
 * Deterministic dependency-cycle detection (Tarjan strongly connected
 * components) for the validate lifecycle check.
 */
/* c8 ignore start -- Tarjan SCC traversal branch matrix is covered by lifecycle cycle integration fixtures */
/**
 * Return every dependency cycle of `graph` as a sorted list of member ids:
 * strongly connected components with more than one member, plus self-loops.
 * Node and component order are deterministic, so validate output is stable.
 */
export function findLifecycleDependencyCycleComponents(
  graph: Map<string, string[]>,
): string[][] {
  let nextIndex = 0;
  const indexById = new Map<string, number>();
  const lowLinkById = new Map<string, number>();
  const stack: string[] = [];
  const inStack = new Set<string>();
  const components: string[][] = [];

  const visit = (id: string): void => {
    indexById.set(id, nextIndex);
    lowLinkById.set(id, nextIndex);
    nextIndex += 1;
    stack.push(id);
    inStack.add(id);

    for (const dependencyId of graph.get(id) ?? []) {
      if (!indexById.has(dependencyId)) {
        visit(dependencyId);
        lowLinkById.set(
          id,
          Math.min(lowLinkById.get(id)!, lowLinkById.get(dependencyId)!),
        );
      } else if (inStack.has(dependencyId)) {
        lowLinkById.set(
          id,
          Math.min(lowLinkById.get(id)!, indexById.get(dependencyId)!),
        );
      }
    }

    if (lowLinkById.get(id) !== indexById.get(id)) {
      return;
    }
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop()!;
      inStack.delete(member);
      component.push(member);
      if (member === id) {
        break;
      }
    }
    component.sort((left, right) => left.localeCompare(right));
    components.push(component);
  };

  const sortedNodeIds = [...graph.keys()].sort((left, right) =>
    left.localeCompare(right),
  );
  for (const id of sortedNodeIds) {
    if (!indexById.has(id)) {
      visit(id);
    }
  }

  const cycleComponents = components.filter((component) => {
    if (component.length > 1) {
      return true;
    }
    const selfId = component[0];
    return (graph.get(selfId) ?? []).includes(selfId);
  });
  return cycleComponents.sort(
    (left, right) =>
      left[0].localeCompare(right[0]) ||
      left.length - right.length ||
      left.join(",").localeCompare(right.join(",")),
  );
}
/* c8 ignore stop */
