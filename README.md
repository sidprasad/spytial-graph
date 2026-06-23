# spytial-graph

*Diagramming in your browser, with semantics.*

[![CI](https://github.com/sidprasad/spytial-graph/actions/workflows/ci.yml/badge.svg)](https://github.com/sidprasad/spytial-graph/actions/workflows/ci.yml)

Write a small graph notation — nodes, edges, and inline spatial `@annotations` — and
SpyTial renders it as a **live, draggable constraint diagram**. Drop a fenced
` ```spytial-graph ` block into Markdown and it comes alive client-side, the way
` ```mermaid ` does.

```spytial-graph
A -> B : left
A -> C : right

@orientation(selector=_links, directions=[below])
@orientation(selector=left,  directions=[left])
@orientation(selector=right, directions=[right])
```

You get a faithful default layout for free; the `@annotations` refine it — orientation,
alignment, grouping, cycles — without rebuilding anything. That block is tagged
` ```spytial-graph `, so in any markdown pipeline it renders as a *live* diagram — this
README is dogfood. See it rendered live at `/examples/md-viewer.html?doc=../README.md`, or
read the intro post, [Your diagram doesn't know what it's
drawing](examples/your-diagram-doesnt-know.md).
> **New here? Start with [GUIDE.md](GUIDE.md)** 

## Try it

No `npm install` — everything loads from CDN:

```bash
npm run serve   # zero-dep static server, port 8100
# /playground/                 live editor (View ⇄ Edit)
# /examples/guide.html         the guide, rendered by spytial-graph itself
# /examples/binary-tree.html   programmatic API demo
# /examples/editable.html      editable graph — edit visually, re-get the notation
# /examples/diagrams-that-edit-back.html   "explorable" post built on the editor
# /examples/your-diagram-doesnt-know.html  intro post, self-contained (CDN engine)
# /examples/md-viewer.html?doc=<file.md>   render any spytial-graph .md live (incl. this README)
```

(Any static server works; one is needed only because the pages load ES modules.)

## The notation

- **Edges** — `A -> B`, or labeled `A -> B : left` (the label becomes a selector).
- **Nodes** are implicit from edges; the id is the name, and every node is a rectangle.
- **Labels** — `A[Alice]` gives a display label, mermaid-style; without one the id is
  shown. The id stays the stable identity that edges reference (handy for generated ids).
- **Sorts** — `A:::Person` gives the node a type, so `selector: Person` matches it.
- **Classes** — `class A,B,C tag` tags several nodes with a cross-cutting group.
- **No header, no direction.** Layout comes from the annotations, not a `TD`/`LR` keyword.

Mermaid arrows (`-->`, `-.->`, `==>`, `---`), pipe labels (`A -->|left| B`), and a leading
`graph`/`flowchart` line are also accepted, so existing diagrams paste in.

## Annotations

Spatial operations, inline, one per line — `@name(arg=value, …)`:

| kind | annotations |
|---|---|
| **constraints** (layout) | `orientation`, `cyclic`, `align`, `group` |
| **directives** (styling) | `atomColor`, `size`, `icon`, `edgeColor`, `attribute`, `hideField`, `hideAtom`, `inferredEdge`, `tag`, `flag`, `projection` |

Values are barewords (`below`), quoted strings (`'left subtree'`, or a comprehension
`'{x: Person | …}'`), numbers, or lists (`[below, left]`). A `%%@name(...)` form is accepted
too, so a block survives being pasted into a vanilla Mermaid renderer. Bad names or
arguments come back on the result as `annotationErrors`.

## Selectors

An edge's label **is** its relation name — that's the model. Two built-in edge relations
and the node sets round it out:

| selector | selects |
|---|---|
| `<label>` | edges carrying that label — `A -> B : left` → `left` |
| `_` | the unlabeled edges |
| `_links` | every edge |
| `<type>` | nodes of that sort — `A:::Person` → `Person` (plain nodes are `Node`) |
| `<class>` | nodes carrying that class — `class A,B team` → `team` |

Each edge is **drawn once** (under its label, or `_`). `_links` and the node-set relations
are selector-only — hidden from drawing so they don't double-draw — but still resolve in
selectors. Name a class and an edge label distinctly; a shared spelling collides them.

## In Markdown

One tag turns on rendering for a whole page; the engine is injected if it isn't already
loaded. **[GUIDE.md](GUIDE.md) is the full walkthrough** — the short version:

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/spytial-graph/src/auto.js"></script>
```

`src/markdown.js` exports, if you'd rather drive it:

| export | |
|---|---|
| `autoRender(opts)` | render every block on the page (injects the engine if absent) |
| `renderSpytialGraphs(root = document, opts)` | render blocks under `root`; returns per-block results |
| `ensureEngineLoaded(opts)` | inject d3 + WebCola + spytial-core if absent |
| `whenEngineReady(ms)` | resolves once the engine is available |

`opts`: `height` (default `360`; per-block `data-height`), `theme`, `injectEngine`. It picks
up the `<pre><code class="language-spytial-graph">` markup that marked, markdown-it, MkDocs,
and Docusaurus emit — no plugin needed.

A block tagged ` ```spytial-graph-editable ` (or any block carrying `data-editable`, or
`autoRender({ editable: true })`) renders the **editor** instead of the read-only view, with a
*copy notation* button — so docs can ship a graph readers edit and copy back out.

## Programmatic API

```js
import { renderSpytialGraph, mountGraph } from 'spytial-graph';

const graph = mountGraph(document.getElementById('out'), { width: 800, height: 600 });
const result = await renderSpytialGraph(graph, `
A -> B
A -> C

@orientation(selector=_links, directions=[below])
`);
```

`renderSpytialGraph(graphEl, source, opts)` →
`{ applied, layout, error, selectorErrors, annotationErrors, parsed, data, instance, rules, hiddenRelations }`.
`mountGraph(container, opts)` creates/returns a `<webcola-cnd-graph>`. `opts.validator` is
`'qualitative'` (default, IIS clash reporting) or `'kiwi'`.

Lower-level inputs still work and **compose** with annotations: `opts.rules` (raw CnD YAML)
and the per-class `registerSpec` registry are merged through the shared `mergeSpecStrings`.

## Editable mode

Render the same graph onto spytial-core's `<structured-input-graph>` editor instead of the
read-only view: add and delete nodes, drag to connect edges, rename relations — constraints
re-solve live — and **re-get the notation** at any time. That round-trip (`text → visual →
edit → text`) is the point.

```js
import { renderSpytialGraphEditable } from 'spytial-graph';

const h = await renderSpytialGraphEditable(document.getElementById('out'), `
A -> B : left
A -> C : right

@orientation(selector=left, directions=[left])
`);

h.onChange(({ source, value }) => {
  console.log(source); // spytial-graph notation, re-derived from the edited graph
  console.log(value);  // its reified value — { atoms, relations } JSON
});
```

`renderSpytialGraphEditable(container, source, opts)` returns a **handle**:

| handle | |
|---|---|
| `getSource()` | re-get spytial-graph notation for the current graph (your `@annotations` re-appended verbatim) |
| `getValue()` | the reified value — `{ atoms, relations }` JSON |
| `onChange(cb)` | runs `cb({ source, value, error })` after every edit; returns an unsubscribe fn |
| `element`, `dataInstance` | the live `<structured-input-graph>` and its data instance |

`serializeToSpytialGraph(data, { annotations })` is that notation serializer on its own — the
inverse of the render pipeline — for a `{ atoms, relations }` object (or anything with
`reify()`). The playground's **Edit** toggle and `/examples/editable.html` are built on it.

## How it renders

```
spytial-graph source (+ @annotations)
  └─ annotations.js → lift @orientation(...) out     → { source, specYaml }
  └─ parse.js       → { nodes, edges, classesPerNode }
  └─ relationalize  → { atoms, relations, hiddenRelations }
  └─ spytial-core   → JSONDataInstance → SGraphQueryEvaluator
                      → parseLayoutSpec → LayoutInstance.generateLayout
  └─ <webcola-cnd-graph>.renderLayout(layout)
```

When constraints can't all hold, `generateLayout` returns a best-feasible counterfactual plus
the minimal conflict (IIS); `renderSpytialGraph` sets the `unsat` attribute and the playground
shows an explanation. Malformed selectors come back as `selectorErrors`.

**Dependencies** (CDN, in order): d3 v4 · `webcola@3.4.0` · `spytial-core@2.9.1`. The last
auto-registers `<webcola-cnd-graph>` and exposes the engine on `window.spytialcore`; the
Markdown path injects all three. Vendor them locally for an offline deploy.

## Limitations

- A small notation — nodes, edges, labels, types, classes (see `parse.js`). No
  sequence/state/Gantt/pie diagrams.
- Edge labels are relations, not free text.
- The read-only view doesn't auto-re-render — call `renderSpytialGraph` again (the playground
  does this on ⌘⏎). For live editing with a notation round-trip, use [editable mode](#editable-mode).
