# Embedding spytial-graphs in Markdown

A **spytial-graph** is a small text notation for a graph with its layout written
inline. You write nodes, edges, and spatial operations as `@annotations`; SpyTial
solves the layout and draws a live, draggable diagram. It runs in the browser —
no build step, no server beyond static hosting.

## The 30-second version

Add one line to any page that renders your Markdown:

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/spytial-graph/src/auto.js"></script>
```

Then write a fenced block, the way you'd write `mermaid`:

````markdown
```spytial-graph
A -> B
B -> C
@orientation(selector=_links, directions=[right])
```
````

Every `spytial-graph` block on the page becomes a diagram. The script pulls in the
renderer (d3, WebCola, spytial-core) for you if the page doesn't already load it.

Wiring it yourself instead of the drop-in tag:

```html
<script type="module">
  import { autoRender } from 'https://cdn.jsdelivr.net/npm/spytial-graph/src/markdown.js';
  autoRender();
</script>
```

## The notation

A node is implicit from any edge, so the smallest graph is one line:

```spytial-graph
A -> B
```

Label an edge after a colon — the label is also a selector you can target:

```spytial-graph
A -> B : yes
A -> C : no
```

A node's id is its name. A `[bracket]` gives it a display label, mermaid-style —
without one the id is shown:

```spytial-graph
u1[Alice] -> u2[Bob]
```

A `:::Sort` tag gives the node a **type**, so `selector: Person` then matches
every node of that type:

```spytial-graph
alice[Alice]:::Person -> acme[Acme]:::Company
bob[Bob]:::Person     -> acme

@atomColor(selector=Person, value='#cfe8d8')
```

The id stays the identity that edges reference; the label is just what's drawn,
and the sort is what selectors match. One sort per node for now — a chain
`:::Person:::Employee` (a linear hierarchy) is reserved for later.

For a cross-cutting group, tag nodes with `class A,B tag`. There is no header and
no `TD`/`LR` direction; layout comes from the annotations, not a keyword.

## Spatial operations

Annotations *are* the layout. Each is one line, `@name(arg=value, …)`:

| annotation | effect |
|---|---|
| `@orientation(selector=_links, directions=[below])` | put each edge's target below its source |
| `@align(selector=row, direction=top)` | line nodes up on an axis |
| `@cyclic(selector=_links, direction=clockwise)` | arrange a cycle as a ring |
| `@group(selector=team, name='Team A')` | draw a labeled region around a set |
| `@atomColor(selector=root, value='#ffe7b3')` | tint nodes |

A `selector` names nodes or edges:

- an **edge label** (`yes`) — the edges carrying it
- **`_`** — the unlabeled edges; **`_links`** — every edge
- a **type** (`Person`) or a **class** (`tag`) — the matching nodes

Put together — a binary tree, children below, left-left and right-right:

```spytial-graph
A -> B : left
A -> C : right
B -> D : left
B -> E : right
C -> F : left
C -> G : right

@orientation(selector=_links, directions=[below])
@orientation(selector=left,  directions=[left])
@orientation(selector=right, directions=[right])
```

If the constraints can't all hold, the diagram still draws the closest feasible
layout and explains the conflict — nothing silently disappears.

## Where it works

`autoRender` looks for the markup a Markdown renderer emits for a fenced block —
`<pre><code class="language-spytial-graph">`. That's what marked, markdown-it,
Prism, highlight.js, MkDocs, and Docusaurus produce, so no plugin is needed. To
render a fragment you injected yourself, call `renderSpytialGraphs(element)`.

## Editable blocks

Tag a block `spytial-graph-editable` instead, and it renders an **editor** rather
than a static diagram — readers add and delete nodes, drag to connect edges, and
rename relations, with the constraints re-solving live:

````markdown
```spytial-graph-editable
A -> B : left
A -> C : right

@orientation(selector=left, directions=[left])
```
````

Each editable block gets a **copy notation** button that re-derives spytial-graph
text from the edited graph — so a reader can change your example and copy the
result back out, `@annotations` and all. (A hand-authored container with
`data-editable`, or `autoRender({ editable: true })` to make every block editable,
works too.)

Driving the editor yourself, outside Markdown — the handle re-gets the notation
(`getSource()`) and the reified value (`getValue()`) on every edit:

```js
import { renderSpytialGraphEditable } from 'https://cdn.jsdelivr.net/npm/spytial-graph/src/index.js';

const h = await renderSpytialGraphEditable(document.getElementById('out'), 'A -> B\nB -> C');
h.onChange(({ source, value }) => {
  console.log(source); // spytial-graph notation, re-derived from the edited graph
  console.log(value);  // its reified value — { atoms, relations }
});
```
