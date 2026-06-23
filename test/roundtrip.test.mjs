// Round-trip tests for the notation serializer (serialize.js), the inverse of
// relationalize.js. Run with `npm test` (plain Node, no framework needed).
//
// For each notation case we assert:
//   1. round-trip equivalence — parse → relationalize → serialize → parse yields
//      the same graph (same nodes/types, classes, and edge multiset), and
//   2. idempotency — serializing the serialized form is a fixed point.
// Plus annotation preservation and that reify()-shaped input (which carries the
// selector-only `_links` and unary class relations) serializes cleanly.

import { parseGraph } from '../src/parse.js';
import { relationalize } from '../src/relationalize.js';
import { serializeToSpytialGraph } from '../src/serialize.js';
import { extractAnnotations } from '../src/annotations.js';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}  ${extra}`); }
}

// Canonical fingerprint of a graph: nodes (id→type→label), classes, edge multiset.
function fingerprint(text) {
  const { source } = extractAnnotations(text);
  const g = parseGraph(source);
  const nodes = [...g.nodes.entries()].map(([id, n]) => `${id}:${n.type ?? 'Node'}:${n.label ?? id}`).sort();
  const classes = [...g.classesPerNode.entries()].map(([id, s]) => `${id}=${[...s].sort().join(',')}`).sort();
  const edges = g.edges.map((e) => `${e.source}->${e.target}:${e.label ?? '_'}`).sort();
  return JSON.stringify({ nodes, classes, edges });
}

function roundTrip(text) {
  const { source, annotationLines } = extractAnnotations(text);
  const data = relationalize(parseGraph(source));
  return serializeToSpytialGraph(data, { annotations: annotationLines });
}

const cases = {
  'unlabeled edges': `A -> B\nB -> C`,
  'labeled edges': `A -> B : left\nA -> C : right`,
  'typed nodes': `A[Person] -> B[Place]\nB -> C`,
  'classed inline': `A:::vip -> B\nB:::vip -> C`,
  'classed via class line': `A -> B\nB -> C\nclass A,B team`,
  'typed + classed': `A[Person]:::vip -> B\nB -> C[Widget]`,
  'isolated nodes': `A -> B\nLonely\nTagged:::special\nTyped[Gadget]`,
  'multi-label same pair': `A -> B : left\nA -> B : right`,
  'empty graph': ``,
  'label only': `A[label="Alice"] -> B`,
  'type + label': `A[Person, label="Alice"] -> B[Place, label="Acme"]`,
  'label with spaces': `A[label="Alice Smith"] -> B[label="Bob Jones"]`,
  'isolated labeled node': `A -> B\nLone[label="Solo"]`,
  'mixed everything': `A[Person, label="Alice"]:::vip -> B : left\nA -> C : right\nB -> D\nclass C,D team\nIsl[Thing]`,
};

for (const [name, text] of Object.entries(cases)) {
  const out = roundTrip(text);
  check(`${name} — round-trip equivalent`, fingerprint(text) === fingerprint(out),
    `\n   in : ${fingerprint(text)}\n   out: ${fingerprint(out)}\n${out}`);
  check(`${name} — idempotent`, out === roundTrip(out));
}

// Annotations re-appended verbatim, after a blank line.
{
  const text = `A -> B : left\nA -> C : right\n\n@orientation(selector=_links, directions=[below])\n@orientation(selector=left, directions=[left])`;
  const out = roundTrip(text);
  check('annotations re-appended',
    out.includes('@orientation(selector=_links, directions=[below])') &&
    out.includes('@orientation(selector=left, directions=[left])'), `\n${out}`);
  check('annotations after a blank line', /\n\n@orientation/.test(out), `\n${out}`);
}

// reify()-shaped input (atoms/relations/types, including `_links` + unary class
// relations) must skip the selector-only relations.
{
  const { atoms, relations } = relationalize(parseGraph(`A:::vip -> B : left\nA -> C`));
  const out = serializeToSpytialGraph({ atoms, relations, types: [] });
  check('reify-shaped input skips _links/unary',
    fingerprint(out) === fingerprint(`A:::vip -> B : left\nA -> C`), `\n${out}`);
  check('no _links leaked into output', !out.includes('_links'), `\n${out}`);
}

// Editor-style data: generated ids with distinct human labels (what
// <structured-input-graph> produces when you add a node labeled "Alice").
{
  const data = {
    atoms: [
      { id: 'Person1', type: 'Person', label: 'Alice' },
      { id: 'Person2', type: 'Person', label: 'Bob' },
    ],
    relations: [
      { id: 'rel_unlabeled', name: '_', types: ['Node', 'Node'],
        tuples: [{ atoms: ['Person1', 'Person2'], types: ['Person', 'Person'] }] },
    ],
  };
  const out = serializeToSpytialGraph(data);
  check('id≠label emits label="…"',
    /Person1\[Person, label="Alice"\]/.test(out) && /Person2\[Person, label="Bob"\]/.test(out), `\n${out}`);
  const g = parseGraph(out);
  check('re-parsed labels survive',
    g.nodes.get('Person1').label === 'Alice' && g.nodes.get('Person2').label === 'Bob', `\n${out}`);
  check('id==label stays bare (no spurious label=)',
    serializeToSpytialGraph({ atoms: [{ id: 'A', type: 'Node', label: 'A' }], relations: [] }) === 'A');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
