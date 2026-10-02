/** A MatchType template is a type variable scoped to one node instance. */
export class TypeVariable {
  parent: TypeVariable = this;
  rank = 0;
  constructor(public allowed: Set<string> | undefined) {}
}

export type PortType = string | TypeVariable;

function root(variable: TypeVariable): TypeVariable {
  let current = variable;
  while (current.parent !== current) current = current.parent;
  while (variable.parent !== variable) {
    const next = variable.parent;
    variable.parent = current;
    variable = next;
  }
  return current;
}

function intersection(a: Set<string> | undefined, b: Set<string> | undefined): Set<string> | undefined {
  if (!a) return b;
  if (!b) return a;
  return new Set([...a].filter(type => b.has(type)));
}

export function describeType(type: PortType): string {
  if (typeof type === "string") return type;
  const allowed = root(type).allowed;
  return allowed ? [...allowed].join(" or ") : "a consistent MatchType";
}

/** Wildcards convey no type evidence. Known constraints must all agree. */
export function connectTypes(expected: PortType, actual: PortType): boolean {
  if (expected === "*" || actual === "*") return true;
  if (typeof expected === "string" && typeof actual === "string") return expected === actual;
  if (typeof expected === "string") return constrainTypes(actual as TypeVariable, new Set([expected]));
  if (typeof actual === "string") return constrainTypes(expected, new Set([actual]));
  let a = root(expected), b = root(actual);
  if (a === b) return true;
  const allowed = intersection(a.allowed, b.allowed);
  if (allowed?.size === 0) return false;
  if (a.rank < b.rank) [a, b] = [b, a];
  b.parent = a;
  if (a.rank === b.rank) a.rank++;
  a.allowed = allowed;
  return true;
}

/** Literal integers can inhabit either INT or FLOAT; connected ports stay exact. */
export function constrainTypes(variable: TypeVariable, candidates: Set<string>): boolean {
  const current = root(variable);
  const allowed = intersection(current.allowed, candidates);
  if (allowed?.size === 0) return false;
  current.allowed = allowed;
  return true;
}
