// Serialize a graph data model back to spytial-graph notation — the inverse of
// relationalize.js. This is the "re-get the notation" half of the round-trip:
//
//   text → parse → relationalize → JSONDataInstance → (edit) → reify → serialize → text
//
// It accepts either a `{ atoms, relations }` object (the shape relationalize.js
// produces and JSONDataInstance.reify() returns) or a data instance with a
// `reify()` method, and returns spytial-graph source text that re-parses to an
// equivalent graph.
//
// The mapping mirrors relationalize.js exactly:
//   atom                       → a node; `type !== 'Node'` ⇒ [Type],
//                                labels.classes ⇒ :::c1:::c2
//   `_` relation               → unlabeled edges            (A -> B)
//   named binary relation      → labeled edges              (A -> B : name)
//   `_links` relation          → skipped (selector-only; duplicates the drawn
//                                edges, so emitting it would double every edge)
//   unary (class) relation     → skipped (class membership is recovered from
//                                each atom's labels.classes instead)
//
// Output is canonical and stable so it's diff-friendly and idempotent: nodes and
// edges keep their first-seen order, a node's type/classes are emitted inline at
// its first appearance, and isolated/decoration-only nodes get a standalone
// declaration line. `serialize(serialize(x))` is a fixed point.

import { DEFAULT_TYPE, DEFAULT_RELATION, ALL_EDGES_RELATION } from './relationalize.js';

// Accept a data instance (anything with reify()) or a plain { atoms, relations }.
function toData(input) {
  if (input && typeof input.reify === 'function') {
    const r = input.reify() || {};
    return { atoms: r.atoms || [], relations: r.relations || [] };
  }
  return { atoms: (input && input.atoms) || [], relations: (input && input.relations) || [] };
}

// Arity of a relation: prefer an actual tuple (robust to spec drift), fall back
// to the declared `types` arity for empty relations.
function arityOf(rel) {
  const t = rel && rel.tuples && rel.tuples[0];
  if (t && Array.isArray(t.atoms)) return t.atoms.length;
  if (rel && Array.isArray(rel.types)) return rel.types.length;
  return 0;
}

// The `[Type]:::class` suffix for a node, or '' if it's a plain default node.
function decorate(atom) {
  let s = '';
  if (atom.type && atom.type !== DEFAULT_TYPE) s += `[${atom.type}]`;
  const classes = atom.labels && atom.labels.classes;
  if (Array.isArray(classes)) {
    for (const c of classes) s += `:::${c}`;
  }
  return s;
}

function hasDecoration(atom) {
  if (atom.type && atom.type !== DEFAULT_TYPE) return true;
  const classes = atom.labels && atom.labels.classes;
  return Array.isArray(classes) && classes.length > 0;
}

// Serialize a graph data model to spytial-graph notation.
//
//   input        — { atoms, relations } or a data instance (with reify())
//   opts.annotations — spatial @annotation text to re-append verbatim after the
//                  graph (string, or array of lines). Editing data never changes
//                  the layout directives, so they round-trip unchanged.
//
// Returns the notation as a string.
export function serializeToSpytialGraph(input, opts = {}) {
  const { atoms, relations } = toData(input);

  const atomById = new Map();
  for (const a of atoms) atomById.set(a.id, a);

  // Drawn edges = binary relations other than the selector-only `_links`. Unary
  // (class) relations are skipped; classes come from each atom's labels.classes.
  const edgeRelations = relations.filter(
    (r) => r.name !== ALL_EDGES_RELATION && arityOf(r) === 2
  );

  // A class name that's also an edge label collapses into one relation name on
  // re-parse (relationalize warns against this too). Surface it rather than emit
  // ambiguous notation silently.
  const edgeNames = new Set(
    edgeRelations.map((r) => r.name).filter((n) => n && n !== DEFAULT_RELATION)
  );
  const classNames = new Set();
  for (const a of atoms) {
    const cs = a.labels && a.labels.classes;
    if (Array.isArray(cs)) for (const c of cs) classNames.add(c);
  }
  const collisions = [...classNames].filter((c) => edgeNames.has(c));
  if (collisions.length && typeof console !== 'undefined') {
    console.warn(
      `serializeToSpytialGraph: name(s) used as both a class and an edge label: ${collisions.join(', ')}`
    );
  }

  const lines = [];
  const declared = new Set();

  // Render an edge endpoint, emitting its [Type]:::class inline the first time
  // the node is seen (so each node is decorated exactly once).
  const endpoint = (id) => {
    const atom = atomById.get(id);
    if (atom && !declared.has(id) && hasDecoration(atom)) {
      declared.add(id);
      return id + decorate(atom);
    }
    declared.add(id);
    return id;
  };

  for (const rel of edgeRelations) {
    const labelSuffix = rel.name && rel.name !== DEFAULT_RELATION ? ` : ${rel.name}` : '';
    for (const t of rel.tuples || []) {
      const a = t.atoms || [];
      if (a.length < 2) continue;
      lines.push(`${endpoint(a[0])} -> ${endpoint(a[1])}${labelSuffix}`);
    }
  }

  // Standalone declarations for nodes no edge introduced — isolated nodes, and
  // nodes that carry only a type/class. (Nodes used in edges were decorated
  // inline above.) A plain isolated node emits as just its bare id.
  for (const a of atoms) {
    if (!declared.has(a.id)) {
      lines.push(a.id + decorate(a));
    }
  }

  let out = lines.join('\n');

  // Re-append the spatial @annotations verbatim. They key off types / labels /
  // classes, which editing the data preserves, so they stay valid.
  const ann = opts.annotations;
  const annText = Array.isArray(ann) ? ann.join('\n') : typeof ann === 'string' ? ann : '';
  if (annText.trim()) {
    out = out ? `${out}\n\n${annText.trim()}` : annText.trim();
  }

  return out;
}
