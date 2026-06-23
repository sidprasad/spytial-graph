// Turn the parsed graph into the JSON shape JSONDataInstance accepts —
// { atoms, relations } — plus the list of relation names that are selector-only
// (queryable but not drawn).
//
// The relation vocabulary is deliberately small. An edge's label *is* its
// relation name; that's the whole model:
//
//   DRAWN (each edge is drawn exactly once):
//     - <label>  — edges carrying that label   (`A -> B : left` → `left`)
//     - `_`      — unlabeled edges             (`A -> B`        → `_`, blanked)
//   SELECTOR-ONLY (hidden, so edges aren't drawn twice — see index.js):
//     - `_links` — every edge, a single handle for "all links"
//     - <class>  — the nodes carrying a class  (`class A,B team` → `team`),
//                  for node annotations like @group / @atomColor
//
// Atom type = the node's `:::Sort` tag (`A:::Person` → 'Person') or 'Node' for a
// plain `A`, so `selector: Person` targets every Person node. The atom's label is
// the node's [bracket] text if given, else the id; the id is always the stable
// identity (what edges reference). Class names (from `class …` lines) are stored
// on each atom under `labels.classes`.

// The type a plain `A` carries (vs. an explicit `A:::Person`). Exported so the
// inverse serializer (serialize.js) knows which type is the implicit default and
// can omit it.
export const DEFAULT_TYPE = 'Node';

// Relation carrying unlabeled edges. index.js blanks this name on the rendered
// edges (an unlabeled edge shouldn't display its synthetic relation name).
export const DEFAULT_RELATION = '_';

// Relation holding every edge — one selector for "all links".
export const ALL_EDGES_RELATION = '_links';

function nodeType(node) {
  return node && node.type ? node.type : DEFAULT_TYPE;
}

export function relationalize({ nodes, edges, classesPerNode }) {
  const atoms = [];
  for (const [id, node] of nodes) {
    const atom = {
      id,
      type: nodeType(node),
      // The [bracket] label wins; otherwise the id is the display label.
      label: node && node.label != null ? node.label : id,
    };
    const classes = classesPerNode.get(id);
    if (classes && classes.size > 0) {
      atom.labels = { classes: Array.from(classes) };
    }
    atoms.push(atom);
  }

  const relations = [];
  const hiddenRelations = []; // relation NAMES to hide from drawing

  const tupleFor = (e) => ({
    atoms: [e.source, e.target],
    types: [nodeType(nodes.get(e.source)), nodeType(nodes.get(e.target))],
  });

  if (edges.length > 0) {
    // Drawn: one relation per label, plus `_` for the unlabeled edges. Each
    // edge lands in exactly one of these, so it's drawn once.
    const byLabel = new Map();
    const unlabeled = [];
    for (const e of edges) {
      if (e.label) {
        if (!byLabel.has(e.label)) byLabel.set(e.label, []);
        byLabel.get(e.label).push(e);
      } else {
        unlabeled.push(e);
      }
    }

    if (unlabeled.length > 0) {
      relations.push({
        id: 'rel_unlabeled',
        name: DEFAULT_RELATION,
        types: [DEFAULT_TYPE, DEFAULT_TYPE],
        tuples: unlabeled.map(tupleFor),
      });
    }

    for (const [label, labelEdges] of byLabel) {
      relations.push({
        id: `lbl_${label}`,
        name: label,
        types: [DEFAULT_TYPE, DEFAULT_TYPE],
        tuples: labelEdges.map(tupleFor),
      });
    }

    // Selector-only: every edge under `_links`. Duplicates the drawn relations,
    // so it's hidden — `selector: _links` resolves, but nothing draws twice.
    relations.push({
      id: 'rel_all_edges',
      name: ALL_EDGES_RELATION,
      types: [DEFAULT_TYPE, DEFAULT_TYPE],
      tuples: edges.map(tupleFor),
    });
    hiddenRelations.push(ALL_EDGES_RELATION);
  }

  // One unary relation per class, naming its member nodes — so node annotations
  // (@group, @atomColor, …) can target `selector: <class>`. Hidden, since the
  // renderer would otherwise draw a unary relation as a self-loop on each member.
  //
  // Name classes and edge labels distinctly: a shared spelling would put a unary
  // and a binary relation under the same name.
  const allClasses = new Set();
  for (const cs of classesPerNode.values()) {
    for (const c of cs) allClasses.add(c);
  }

  for (const cls of allClasses) {
    const members = [];
    for (const [id, classes] of classesPerNode) {
      if (classes.has(cls)) members.push(id);
    }
    relations.push({
      id: `cls_${cls}`,
      name: cls,
      types: [DEFAULT_TYPE],
      tuples: members.map(id => ({
        atoms: [id],
        types: [nodeType(nodes.get(id))],
      })),
    });
    hiddenRelations.push(cls);
  }

  return { atoms, relations, hiddenRelations };
}
