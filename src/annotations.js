// Inline spatial annotations — the `@orientation(...)` decorator syntax.
//
// Spatial operations (orientation, alignment, cyclic, grouping, colors, …) used
// to live in a *separate* YAML "rules" spec. This module lets you write them
// inline in the diagram source instead, mirroring the Python decorator DSL
// (see spytial-py/spytial/annotations.py). A single block of text then fully
// describes both the graph and how it should be laid out:
//
//   flowchart TD
//     A -->|left| B
//     A -->|right| C
//     class A,B,C tree
//
//   @orientation(selector=_links, directions=[below])
//   @orientation(selector=left,  directions=[left])
//   @orientation(selector=right, directions=[right])
//
// `extractAnnotations(rawSource)` lifts the annotation lines out of the source
// (so parse.js never sees them) and compiles them into the same compact
// authoring-YAML the rest of the codebase already consumes — one-line flow-map
// list items under `constraints:` / `directives:`, which round-trip cleanly
// through registry.js's extractBlocks merge.
//
// Two accepted line forms:
//   @name(args)        — bare decorator (primary)
//   %%@name(args)      — mermaid-comment-guarded, so the block still degrades
//   %% @name(args)       gracefully if pasted into a vanilla Mermaid renderer.

// Vocabulary, mirroring Python's CONSTRAINT_TYPES / DIRECTIVE_TYPES. Only the
// name→category split matters here: compilation is generic (every annotation
// becomes `{ <name>: { ...kwargs } }`), so all of them are supported with no
// per-annotation code.
export const CONSTRAINT_NAMES = new Set([
  'orientation', 'cyclic', 'align', 'group',
]);

export const DIRECTIVE_NAMES = new Set([
  'atomColor', 'size', 'icon', 'edgeColor', 'attribute',
  'hideField', 'hideAtom', 'inferredEdge', 'tag', 'flag', 'projection',
]);

// An annotation occupies a whole line. We accept an optional `%%`/`%% ` guard.
const ANNOTATION_LINE = /^\s*(?:%%\s*)?@([A-Za-z_]\w*)\s*\(([\s\S]*)\)\s*;?\s*$/;
// A faster pre-check so we don't run the strict regex on every diagram line.
const LOOKS_LIKE_ANNOTATION = /^\s*(?:%%\s*)?@/;

// Split a comma-separated argument list at the TOP level only — commas inside
// [...], {...}, (...), or quotes are preserved. Returns trimmed pieces.
function splitTopLevel(s) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '[' || ch === '{' || ch === '(') { depth++; buf += ch; continue; }
    if (ch === ']' || ch === '}' || ch === ')') { depth--; buf += ch; continue; }
    if (ch === ',' && depth === 0) { parts.push(buf.trim()); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim() !== '') parts.push(buf.trim());
  return parts;
}

// True if `s` contains an `=` at the top level (not inside quotes/brackets).
function hasTopLevelEquals(s) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '[' || ch === '{' || ch === '(') { depth++; continue; }
    if (ch === ']' || ch === '}' || ch === ')') { depth--; continue; }
    if (ch === '=' && depth === 0) return true;
  }
  return false;
}

function stripQuotes(s) {
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
    return s.slice(1, -1);
  }
  return null;
}

// Parse one argument value into a JS value:
//   [a, b]      → ['a', 'b']         (list; elements parsed recursively)
//   'text'      → 'text'             (quoted string, quotes removed)
//   3 / 3.5     → 3 / 3.5            (number)
//   below       → 'below'            (bareword string)
function parseValue(raw) {
  const s = raw.trim();
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (inner === '') return [];
    return splitTopLevel(inner).map(parseValue);
  }
  const unq = stripQuotes(s);
  if (unq !== null) return unq;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

// Parse `key=value, key2=[a, b], …` into an object. Throws on a malformed pair.
function parseArgs(argStr) {
  const kwargs = {};
  const trimmed = argStr.trim();
  if (trimmed === '') return kwargs;
  for (const piece of splitTopLevel(trimmed)) {
    const eq = piece.indexOf('=');
    if (eq === -1) {
      throw new Error(`expected key=value, got "${piece}"`);
    }
    const key = piece.slice(0, eq).trim();
    const val = piece.slice(eq + 1).trim();
    if (!/^[A-Za-z_]\w*$/.test(key)) {
      throw new Error(`invalid argument name "${key}"`);
    }
    // A top-level `=` inside the value (outside quotes/brackets) means the args
    // weren't comma-separated, e.g. `selector=_links directions=[below]`.
    if (hasTopLevelEquals(val)) {
      throw new Error(`missing comma before "${key}" arguments`);
    }
    kwargs[key] = parseValue(val);
  }
  return kwargs;
}

// ── YAML emission ───────────────────────────────────────────────────────────
// Emit values back as compact flow-style YAML. Strings that contain
// YAML-significant characters are single-quoted (with '' escaping) so selectors
// like '{x: Person | x}' and names like 'left subtree' survive the round-trip.
const YAML_NEEDS_QUOTE = /[\s:{}\[\],&*#?|<>=!%@`'"]/;

function emitScalar(v) {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const s = String(v);
  if (s === '' || YAML_NEEDS_QUOTE.test(s)) {
    return `'${s.replace(/'/g, "''")}'`;
  }
  return s;
}

function emitValue(v) {
  if (Array.isArray(v)) return `[${v.map(emitValue).join(', ')}]`;
  return emitScalar(v);
}

// Compile a single annotation to a YAML list-item body, e.g.
//   orientation: { selector: _links, directions: [below] }
// `flag` is special-cased to a scalar payload (`flag: hideDisconnected`),
// matching the Python serializer.
function emitEntry(name, kwargs) {
  if (name === 'flag') {
    const flagName = kwargs.name != null ? kwargs.name : Object.values(kwargs)[0];
    return `flag: ${emitScalar(flagName != null ? flagName : '')}`;
  }
  const pairs = Object.entries(kwargs).map(([k, v]) => `${k}: ${emitValue(v)}`);
  return `${name}: { ${pairs.join(', ')} }`;
}

// Extract inline annotations from `rawSource`.
//
// Returns { source, specYaml, annotationLines, errors }:
//   source          — the input with annotation lines removed (feed to parseGraph)
//   specYaml        — authoring YAML for the compiled constraints/directives, or
//                     '' if none. Shape:
//                     `constraints:\n  - <entry>\n directives:\n  - <entry>`
//   annotationLines — the raw `@...` lines that compiled successfully, verbatim
//                     and in source order. The serializer re-appends these to
//                     round-trip the notation: editing the graph's *data* never
//                     touches the layout directives, and specYaml is a lossy
//                     compiled form, so we keep the originals.
//   errors          — [{ line, text, message }] for unknown names / malformed args
export function extractAnnotations(rawSource) {
  const lines = String(rawSource ?? '').split(/\r?\n/);
  const kept = [];
  const constraints = [];
  const directives = [];
  const annotationLines = [];
  const errors = [];

  lines.forEach((line, i) => {
    if (!LOOKS_LIKE_ANNOTATION.test(line)) {
      kept.push(line);
      return;
    }
    const m = line.match(ANNOTATION_LINE);
    if (!m) {
      // Looks like an annotation but doesn't parse — report it, and drop the
      // line so it can't confuse the flowchart parser.
      errors.push({ line: i + 1, text: line.trim(), message: 'malformed annotation' });
      return;
    }
    const name = m[1];
    const isConstraint = CONSTRAINT_NAMES.has(name);
    const isDirective = DIRECTIVE_NAMES.has(name);
    if (!isConstraint && !isDirective) {
      errors.push({ line: i + 1, text: line.trim(), message: `unknown annotation "@${name}"` });
      return;
    }
    let kwargs;
    try {
      kwargs = parseArgs(m[2]);
    } catch (err) {
      errors.push({ line: i + 1, text: line.trim(), message: err.message });
      return;
    }
    let entry;
    try {
      entry = emitEntry(name, kwargs);
    } catch (err) {
      errors.push({ line: i + 1, text: line.trim(), message: err.message });
      return;
    }
    (isConstraint ? constraints : directives).push(entry);
    annotationLines.push(line);
  });

  const source = kept.join('\n');

  let specYaml = '';
  if (constraints.length > 0 || directives.length > 0) {
    let out = '';
    if (constraints.length > 0) {
      out += 'constraints:\n';
      for (const c of constraints) out += `  - ${c}\n`;
    }
    if (directives.length > 0) {
      out += 'directives:\n';
      for (const d of directives) out += `  - ${d}\n`;
    }
    specYaml = out;
  }

  return { source, specYaml, annotationLines, errors };
}
