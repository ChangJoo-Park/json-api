/**
 * Takes an arbitrary path string e.g. "user.contact.phone" and locates the
 * corresponding property on an object `obj` and deletes it (ie. does
 * `delete obj.user.contact.phone`). It doesn't use eval, which makes it safer.
 */
export function deleteNested(path, object) {
  try {
    const pathParts = path.split(".");
    const lastPartIndex = pathParts.length - 1;
    const lastPart = pathParts[lastPartIndex];
    const containingParts = pathParts.slice(0, lastPartIndex);
    const container = containingParts.reduce(((obj, part) => obj[part]), object);

    if(container.hasOwnProperty(lastPart)) {
      delete container[lastPart];
      return true;
    }
    else {
      throw new Error("The last property in the path didn't exist on the object.");
    }
  }

  catch(error) {
    return false;
  }
}

/**
 * Returns whether one array's items are a subset of those in the other.
 * Both array's elements are assumed to be unique.
 */
export function isSubsetOf(setArr, potentialSubsetArr) {
  const set = new Set(setArr);

  return potentialSubsetArr.every((it) => set.has(it) === true);
}

export function isPlainObject(obj) {
  return typeof obj === "object" && !(Array.isArray(obj) || obj === null);
}

/**
 * Note that this is only safe with chars in the BMP.
 * See: https://mathiasbynens.be/notes/javascript-unicode
 */
export const stripLeadingBMPChar = (char) => (string) => {
  // The below works because, though string[0] could be a surrogate,
  // it will only === char if it's not: "the ranges for the
  // high surrogates, low surrogates, and valid BMP characters
  // are disjoint, [so] it is not possible for a surrogate to
  // match a BMP character".
  return string[0] === char ? string.slice(1) : string;
};

/**
 * Perform a pseudo-topological sort on the provided graph. Pseudo because it
 * assumes that each node only has 0 or 1 incoming edges, as is the case with
 * graphs for parent-child inheritance hierarchies (w/o multiple inheritance).
 * Uses https://en.wikipedia.org/wiki/Topological_sorting#Kahn.27s_algorithm
 *
 * @param  {string[]} nodes A list of nodes, where each node is just a string.
 *
 * @param {string[]} roots The subset of nodes that have no incoming edges.
 *
 * @param  {object} edges The edges, expressed such that each key is a starting
 * node A, and the value is a set of nodes (as an object literal like
 * {nodeName: true}) for each of which there is an edge from A to that node.
 *
 * @return {string[]} The nodes, sorted.
 */
export function pseudoTopSort(nodes, edges: {[from: string]: {[to: string]: true}}, roots) {
  // Do some defensive copying, in case the caller didn't.
  roots = roots.slice();
  nodes = nodes.slice();
  edges = {...edges};
  for(const key in edges) { edges[key] = {...edges[key]}; }

  // "L = Empty list that will contain the sorted elements"
  const sortResult: string[] = [];

  // "while S is non-empty do"
  while(roots.length) {
    // "remove a node n from S"
    // We shift() instead of pop() to we preserve more of the
    // original order, in case it was significant to the user.
    const thisRoot = <string>roots.shift();
    const thisRootChildren = edges[thisRoot] || {};

    // "add n to tail of L"
    sortResult.push(thisRoot);

    // "for each node m with an edge e from n to m do"
    for(const child in thisRootChildren) {
      // "remove edge e from the graph"
      delete thisRootChildren[child];

      // SKIP: "if m has no other incoming edges..."
      // we don't need this check because we assumed max 1 incoming edge.
      // But: "then insert m into S".
      roots.push(child);
    }
  }

  return sortResult;
}