# Your diagram doesn't know what it's drawing

*A box-and-arrow picture is a drawing. I wanted a model — something with a
meaning under it, that I can constrain, query, and get back as text.*

I draw a lot of diagrams. Boxes, arrows, a dashed line for the part I'm not sure
of yet. For years the workflow was: draw it by hand, fight a layout tool, and
either way end up with a flat, final, *dead* picture. A PNG you screenshot,
paste, and three weeks later redraw from scratch because one box moved.

Mermaid fixed one real thing about this: the diagram became *text*. You write
`A --> B`, you get an arrow, and the diagram now lives in your repo, diffs in
your PR, survives. That's a genuine win and I don't want to undersell it.
spytial-graph keeps it — drop one block into a page and it comes alive in the
browser, no build step:

```spytial-graph
a[Alice] -> b[Bob]   : knows
b        -> c[Carol] : knows
a        -> c        : knows
```

But notice what that Mermaid text *is*. It's a drawing program. `graph TD` means
"lay this out top-down." `A --> B` means "draw an arrow." The text describes the
*picture*. It does not describe the *thing*. The renderer doesn't know A and B
are people, or files, or states — it knows they're boxes and you'd like an
arrow. Ask it to "put every Person to the left of the File they own" and it has
no idea what you mean. There are no Persons, no Files, no *owns*. Boxes and
arrows, all the way down.

## Start from the meaning

spytial-graph starts from the other end. The text isn't a drawing program; it's
a tiny model. `a[Alice]:::Person` says: there's an atom, its identity is `a`,
you'd display it as Alice, and its *sort* is Person. `a -> f : owns` says:
there's an *owns* relation from `a` to `f`. None of that mentions the picture.
The picture is what you get when you stop talking.

And when you *do* want to say something about the picture, you say it in terms of
the model, not the pixels:

```spytial-graph
a[Alice]:::Person -> f[budget.xlsx]:::File : owns
b[Bob]:::Person   -> f                     : owns
c[Carol]:::Person -> g[notes.md]:::File    : owns

@orientation(selector=owns, directions=[right])
@atomColor(selector=Person, value='#e7f0ff')
@atomColor(selector=File,   value='#fff1d9')
```

`selector=owns` is *every owns-edge*; `selector=Person` is *every Person* —
because owns and Person are real things in the model, not spellings on a box.
You're not nudging boxes. You state a constraint and a solver finds a layout
that satisfies it — or tells you, precisely, that it can't, and which
constraints are fighting. A picture can't be wrong. A picture-*with-claims* can,
and that's the entire point.

## The arrow goes both ways

Here's the part I find genuinely delightful. Because the text is a model and not
a drawing, you can run it backwards. Render a graph into an *editor*, rearrange
it by hand, add a node, draw an edge — then ask for the notation back. You get
text again: the same little language you started from, your annotations
re-appended verbatim.

```spytial-graph-editable
a[Alice] -> b[Bob]   : reports
c[Carol] -> b        : reports

@orientation(selector=reports, directions=[below])
```

Drag a node, add one, connect it — then hit **⧉ notation** in the corner. That's
your edited graph, as text you can paste back into the repo. The picture and the
source aren't two artifacts you keep in sync by hand. They're one object seen
from two sides. Edit either; the other is just a projection away.

## Small on purpose

This is a small language, deliberately. Nodes, edges, labels, sorts, classes; a
handful of spatial annotations; no swimlanes, no Gantt charts, no sequence
diagrams. What the smallness buys is that the diagram *means something*: there's
a model under the picture, the layout is a consequence you can argue with, and
you can always recover your text.

A diagram you can't query, can't constrain, and can't get back as source isn't a
model of your system. It's a drawing of one. I wanted the model.

---

*spytial-graph is a few kilobytes over a CDN — the one tag below turns every
`spytial-graph` block on this page into a live diagram. [Source and the notation
guide are on GitHub](https://github.com/sidprasad/spytial-graph).*

<!--
  This is what makes the blocks above live. It runs in any markdown pipeline
  that passes raw HTML through and executes scripts (a blog engine, MkDocs,
  Docusaurus, VitePress, a `marked`-based viewer). GitHub's preview strips
  <script>, so there the blocks just show as code fences.

  The CDN line works once spytial-graph is published to npm:
    <script type="module" src="https://cdn.jsdelivr.net/npm/spytial-graph/src/auto.js"></script>
  Until then, point it at a local checkout (as below) and serve with `npm run serve`.
-->
<script type="module" src="../src/auto.js"></script>
