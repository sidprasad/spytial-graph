# spytial-mermaid (prototype)

Apply SpyTial spatial constraints on top of mermaid.js flowcharts.

## What it does

Mermaid renders normally. Then spytial reads the SVG, computes new positions
that satisfy a class-keyed spec, and rewrites the SVG: node `transform`s
get updated and edges get redrawn as straight lines between the new endpoints.

```js
import { registerSpec, render } from './src/index.js';

registerSpec('tree', `
constraints:
  - orientation: { selector: child, directions: [below] }
  - align: { selector: child, direction: vertical }
`);

await render(document.getElementById('out'), `
graph TD
    root:::tree --> a:::tree
    root:::tree --> b:::tree
    a:::tree --> a1:::tree
    a:::tree --> a2:::tree
`);
```

## Architecture (Shape B: mermaid owns layout, spytial post-nudges)

```
mermaid source
   │
   ├── parse.js          → { nodes, edges, classesPerNode }
   │
   ├── mermaid.render()  → SVG (mermaid's own positions)
   │
   ├── relationalize.js  → JSONDataInstance shape
   ├── registry.js       → merge specs from class names
   │
   ├── spytial runHeadlessLayout → target positions {id, x, y}
   │
   └── postprocess.js    → mutate SVG: move <g class="node">, redraw <path>
```

## Public API

```js
registerSpec(className: string, yamlSpec: string): void
render(targetEl: HTMLElement, source: string, opts?: { extraSpec?: string }): Promise<void>
clearRegistry(): void
```

## Unsat highlighting

When the constraint system is over-determined, spytial-core reports
which constraints conflict. We pull those out (via
`LayoutInstance.generateLayout`'s `conflictingConstraints` /
`overlappingNodes` fields) and tint the affected nodes and edges red
directly on the mermaid SVG. The render result includes a `conflicts`
object so callers can also inspect programmatically:

```js
const result = await render(el, source);
if (result.conflicts.count > 0) {
  console.warn(`${result.conflicts.count} unsat constraints`,
               result.conflicts.atomIds, result.conflicts.pairs);
}
```

Two notes on how spytial reports conflicts:
- Conflicts are returned as the *constraints* involved, not a complete
  enumeration of affected pairs. Spytial's solver short-circuits per
  node, so for a 6-edge graph where every edge has a contradictory
  orientation, you may see 5 of 6 pairs highlighted, not all 6.
- `overlappingNodes` is reported separately — node-pair overlaps where
  no minDistance can be found. Those get highlighted as nodes too.

The example demo has a "render unsat spec" button that piles a
contradictory `orientation: above` on top of the existing `below`
constraint to exercise this path.

## Edge labels become first-class relations

Mermaid edge labels (`A -->|left| B`) are *not* just visual annotations
here — each unique label becomes its own binary relation that spytial can
target directly. Given:

```
graph TD
    A -->|left|  B
    A -->|right| C
```

the relationalizer emits relations `edge` (catch-all, both tuples),
`left` (just `(A,B)`), and `right` (just `(A,C)`). Then a spec can do:

```yaml
constraints:
  - orientation: { selector: left,  directions: [leftOf] }
  - orientation: { selector: right, directions: [rightOf] }
```

— the natural way to express binary-tree shape. The `examples/binary-tree.html`
demo uses this pattern.

**Name collision warning:** if a class name and an edge label share a
spelling, two relations will be emitted with the same name — one unary
(class membership), one binary (label). spytial will likely complain.
Name your classes and labels distinctly.

## Known limitations (v1)

- **Straight-line edges.** When spytial moves nodes, edges are redrawn as
  straight lines between new node centers (clipped to node AABBs).
  Mermaid's pretty curved routing is lost on any moved edge. Recomputing
  curves would require re-running an edge routing algorithm; that's v2.
- **Flowchart only.** `graph TD`/`graph LR`/`flowchart TD` etc. No
  classDiagram, stateDiagram, sequenceDiagram, Gantt, pie, journey.
- **Mermaid `classDef fill:#...` styles** still apply (mermaid renders the
  shape). spytial directives govern positions; mermaid CSS governs paint.
- **Spytial *directives* are silent under Shape B.** `atomColor`, `icon`,
  `edgeColor` etc. have no visual effect because mermaid (not spytial)
  renders the SVG. Only *constraints* (positions) take effect.
- **No live re-render** on source/registry change — call `render` again.

## Running the example

The example loads both `mermaid` and `spytial-core` from CDN, so no
`npm install` is needed:

```bash
# from the spytial-mermaid directory
python3 -m http.server 8000
# open http://localhost:8000/examples/binary-tree.html
```

## How it relates to spytial-core's other integrations

This is Shape B from `spytial-core-could-be-integrated-abstract-moler.md` —
the user prefers mermaid's pretty rendering and accepts that constraint
post-nudging fights mermaid's layout. Shape A (spytial owns layout, mermaid
syntax is input notation) is the safer alternative; it would render via
`<webcola-cnd-graph>` and ignore mermaid's SVG.

Mermaid is not a "host language" in the spytial-core sense — there are no
runtime values to relationalize. The mermaid source IS the relational data.
Identity is trivial (mermaid node IDs are unique per source), so none of the
hash-cons / counter / `StableName` machinery applies.
