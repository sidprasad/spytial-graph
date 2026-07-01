// Integration test: drives the REAL spytial-core pipeline (not just the string
// round-trip) to verify that the atom/relation types produced by relationalize.js
// are accepted by JSONDataInstance, that the SGraphQueryEvaluator resolves
// selectors, and (best effort) that LayoutInstance.generateLayout succeeds. The
// point is to confirm an untyped node is reachable via `univ` and correctly
// typed — before/after flipping DEFAULT_TYPE.
//
//   node test/sgq-integration.test.mjs
//
// JSONDataInstance + SGraphQueryEvaluator come from spytial-core's node-friendly
// ./evaluator bundle (no DOM). LayoutInstance/parseLayoutSpec only ship in the
// browser IIFE global bundle, which we load under minimal browser-global stubs.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseGraph } from '../src/parse.js';
import { relationalize, DEFAULT_TYPE } from '../src/relationalize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(__dirname, '../../spytial-core/dist');

let pass = 0, fail = 0, skip = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.error(`FAIL    ${name}  ${extra}`); }
}
function note(msg) { skip++; console.log(`  skip  ${msg}`); }

console.log(`DEFAULT_TYPE in relationalize.js = ${JSON.stringify(DEFAULT_TYPE)}\n`);

// This is an integration test against a *sibling* build of spytial-core (loaded
// as globals, the way a host app consumes it). It can only run where that build
// exists; skip cleanly (exit 0) otherwise so `npm test` stays green standalone.
const EVAL_BUNDLE = resolve(CORE_DIR, 'evaluator.mjs');
if (!existsSync(EVAL_BUNDLE)) {
  console.log(`  skip  spytial-core build not found at ${CORE_DIR} — integration test skipped.`);
  console.log(`\n0 passed, 0 failed, 1 skipped`);
  process.exit(0);
}

// --- node-friendly evaluator bundle ------------------------------------------
const evalMod = await import(EVAL_BUNDLE);
const { JSONDataInstance, SGraphQueryEvaluator } = evalMod;
check('evaluator.mjs exposes JSONDataInstance + SGraphQueryEvaluator',
  !!(JSONDataInstance && SGraphQueryEvaluator));

// --- browser global bundle (for LayoutInstance) under stubs ------------------
function loadBrowserCore() {
  const stub = () => ({
    style: {}, setAttribute() {}, getAttribute() { return null; },
    appendChild() {}, addEventListener() {}, attachShadow() { return stub(); },
    querySelector() { return null; }, querySelectorAll() { return []; },
    setProperty() {}, removeProperty() {}, classList: { add() {}, remove() {} },
  });
  globalThis.window = globalThis;
  globalThis.document = {
    createElement: stub, createElementNS: stub,
    head: stub(), body: stub(), addEventListener() {},
  };
  globalThis.HTMLElement = class {};
  globalThis.customElements = { define() {}, get() { return undefined; } };
  globalThis.navigator = { userAgent: 'node' };
  const src = readFileSync(resolve(CORE_DIR, 'browser/spytial-core-complete.global.js'), 'utf8');
  (0, eval)(src);
  return globalThis.spytialcore;
}
let browserCore = null;
try { browserCore = loadBrowserCore(); }
catch (e) { note(`browser bundle not loadable under stubs (${e.message}) — LayoutInstance checks skipped`); }

// --- helpers -----------------------------------------------------------------
function instanceFor(source) {
  const { atoms, relations, hiddenRelations } = relationalize(parseGraph(source));
  return { atoms, relations, hiddenRelations, instance: new JSONDataInstance({ atoms, relations }) };
}
function newEvaluator(instance) {
  const ev = new SGraphQueryEvaluator();
  ev.initialize({ sourceData: instance });
  return ev;
}
// Pull atom ids out of whatever shape evaluate() returns (probe at runtime).
function idsOf(res) {
  const r = res && (res.value ?? res.result ?? res.tuples ?? res.atoms ?? res);
  const flat = [];
  const push = (x) => { if (x == null) return; flat.push(x && x.id != null ? x.id : (x.atom != null ? x.atom : x)); };
  if (Array.isArray(r)) {
    for (const el of r) {
      if (Array.isArray(el)) el.forEach(push);
      else if (el && Array.isArray(el.atoms)) el.atoms.forEach(push);
      else push(el);
    }
  }
  return flat.map(x => (typeof x === 'object' && x && x.id != null ? x.id : x)).filter(x => x != null);
}

// =============================================================================
// Case A — types are accepted; untyped vs typed atoms resolve correctly.
// =============================================================================
console.log('Case A: JSONDataInstance typing');
{
  const src = `A -> B\nB -> C:::Widget`;
  const { atoms, instance } = instanceFor(src);
  console.log('   atom types: ' + atoms.map(a => `${a.id}:${JSON.stringify(a.type)}`).join(', '));

  let aType, aErr = null, cType, cErr = null;
  try { aType = instance.getAtomType('A'); } catch (e) { aErr = e; }
  try { cType = instance.getAtomType('C'); } catch (e) { cErr = e; }
  check('A: getAtomType(untyped "A") does not throw', aErr === null, aErr && aErr.message);
  console.log('      getAtomType("A") = ' + JSON.stringify(aType && { id: aType.id, types: aType.types }));
  check('A: getAtomType(typed "C") is "Widget"', !!cType && cType.id === 'Widget',
    cErr ? cErr.message : JSON.stringify(cType && cType.id));
}

// =============================================================================
// Case B — SGQ evaluator: univ captures untyped atoms; named type is precise.
// =============================================================================
console.log('\nCase B: SGraphQueryEvaluator selectors');
{
  const src = `A -> B\nC:::Widget -> A`;
  const { instance } = instanceFor(src);
  const ev = newEvaluator(instance);

  let univRes, univErr = null;
  try { univRes = ev.evaluate('univ'); } catch (e) { univErr = e; }
  check('B: evaluate("univ") does not throw', univErr === null, univErr && univErr.message);
  if (!univErr) {
    const ids = new Set(idsOf(univRes));
    console.log('      univ → ' + JSON.stringify([...ids]));
    check('B: univ includes untyped A and B, and typed C',
      ids.has('A') && ids.has('B') && ids.has('C'), JSON.stringify([...ids]));
  }

  let wRes, wErr = null;
  try { wRes = ev.evaluate('Widget'); } catch (e) { wErr = e; }
  check('B: evaluate("Widget") does not throw', wErr === null, wErr && wErr.message);
  if (!wErr) {
    const ids = new Set(idsOf(wRes));
    console.log('      Widget → ' + JSON.stringify([...ids]));
    check('B: Widget resolves to exactly {C}', ids.has('C') && !ids.has('A') && !ids.has('B'),
      JSON.stringify([...ids]));
  }
}

// =============================================================================
// Case C — full LayoutInstance path (index.js steps 1-4), if browser core loaded.
// =============================================================================
console.log('\nCase C: full LayoutInstance.generateLayout');
if (!browserCore) {
  note('C: browser core unavailable — skipped');
} else {
  const { parseLayoutSpec, LayoutInstance, JSONDataInstance: BJSON, SGraphQueryEvaluator: BEval } = browserCore;
  check('C: browser core has parseLayoutSpec + LayoutInstance', !!(parseLayoutSpec && LayoutInstance));

  function runLayout(source, rulesYaml = '') {
    const { atoms, relations } = relationalize(parseGraph(source));
    const instance = new BJSON({ atoms, relations });
    const evaluator = new BEval();
    evaluator.initialize({ sourceData: instance });
    const spec = parseLayoutSpec(rulesYaml || '');
    const li = new LayoutInstance(spec, evaluator, 0, true, undefined, 'qualitative');
    return li.generateLayout(instance);
  }

  // C1: bare graph, no spec.
  let r1, e1 = null;
  try { r1 = runLayout(`A -> B\nB -> C:::Widget`); } catch (e) { e1 = e; }
  check('C1: generateLayout(no spec) does not throw', e1 === null, e1 && (e1.stack || e1.message));
  if (!e1) check('C1: produced a layout with no selectorErrors',
    !!r1.layout && (r1.selectorErrors || []).length === 0,
    JSON.stringify({ err: r1.error, sel: r1.selectorErrors }));

  // C2: a spec whose selector is `univ` — must resolve against untyped atoms.
  let r2, e2 = null;
  const univSpec = `directives:\n  - atomColor: { selector: univ, value: "#eeeeee" }`;
  try { r2 = runLayout(`A -> B\nC:::Widget -> A`, univSpec); } catch (e) { e2 = e; }
  check('C2: generateLayout(univ selector) does not throw', e2 === null, e2 && (e2.stack || e2.message));
  if (!e2) check('C2: univ-selector spec applied with no selectorErrors',
    (r2.selectorErrors || []).length === 0,
    JSON.stringify({ err: r2.error, sel: r2.selectorErrors }));
}

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail ? 1 : 0);
