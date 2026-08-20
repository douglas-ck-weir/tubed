// Shared engine loader for Tubed tests and comparison scripts.
//
// Loads a Tubed single-file HTML build into a stubbed-DOM vm sandbox and
// returns its engine surface. Parameterised by path so the SAME assertions
// can be run against index.html (live) and any candidate or archived build —
// that's how a change proves it is equivalent where it should be and different
// only where it is intended to be.
//
// Usage:
//   import { loadEngine } from './lib/engine.mjs';
//   const T = loadEngine();                      // defaults to index.html
//   const V = loadEngine('backups/index.html.pre-unified-engine.2026-08-05.bak');
//   const T = loadEngine(process.env.TUBED_HTML || 'index.html');

import { readFileSync } from 'fs';
import vm from 'vm';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..', '..');

// Everything a test or comparison script might reasonably want. Names that
// don't exist in a given build are simply omitted (see the guarded export
// suffix below), so this list can stay ahead of any one build.
const EXPORT_NAMES = [
  // data
  'NETWORK', 'WAIT_MINS', 'WAIT_MINS_DEFAULT', 'COORDS', 'PUZZLE_STATIONS',
  'INTERCHANGE_MINS', 'OSI_PAIRS', 'SCORING_VERSION', 'TIMES', 'TIMES_BY_LINE',
  'LINE_COLOURS', 'PLATFORM_GROUPS',
  // line / network helpers
  'displayLine', 'lineColour', 'stationsForDisplayLine', 'shareSubLine',
  'subLineSpansJunction', 'linesAtStation', 'getTime', 'lineOverrideTime',
  '_stationName', '_isMultiOccurrence', '_nodeKey',
  // cost model
  'waitTime', 'firstHopOnLeg', 'interchangeTime', 'platformPeers', 'osiTime',
  'isOsi', 'travelTimeOnLine', '_WAIT_CACHE',
  // v2 only — absent in index.html, guarded below
  'scoreLegs', 'boardingWait', 'divergenceHopWait', 'branchesServingHop',
  // search + scoring
  'buildGraph', 'dijkstra', 'buildUserLegs', 'scoreUserRoute',
  'bestOneChangeMins', 'bestTwoChangeMins',
  // puzzle
  'todayPuzzle', 'pickOptimal', 'isPublishableOptimal', 'londonDateParts',
  'seededRng', 'requiresChange', 'countDistinctChanges',
];

function makeStub(name = 'stub') {
  const fn = function () { return makeStub(name + '()'); };
  return new Proxy(fn, {
    get(_t, p) {
      if (p === Symbol.toPrimitive) return () => '';
      if (p === 'then') return undefined;
      if (p === 'length') return 0;
      if (p === 'forEach' || p === 'map' || p === 'filter') return () => [];
      return makeStub(`${name}.${String(p)}`);
    },
    apply() { return makeStub(name + '()'); },
    has() { return true; },
  });
}

function makeStorage() {
  const data = {};
  return {
    getItem: k => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: k => { delete data[k]; },
    clear: () => { Object.keys(data).forEach(k => delete data[k]); },
    _raw: data,
  };
}

/**
 * @param {string} htmlPath  path to the build, absolute or relative to repo root
 * @param {{extraExports?: string[]}} [opts]
 * @returns engine surface object, plus `_ctx` (the sandbox) and `_path`
 */
export function loadEngine(htmlPath = 'index.html', opts = {}) {
  const abs = path.isAbsolute(htmlPath) ? htmlPath : path.join(ROOT, htmlPath);
  const html = readFileSync(abs, 'utf8');

  // Only inline classic <script> blocks (no attributes). A build that moves to
  // type="module" would break this loader AND sandbox.html — see the note in
  // the project_tubed_sandbox memory. Fail loudly rather than silently.
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  if (scripts.length === 0) {
    throw new Error(`no inline <script> blocks found in ${abs}`);
  }

  const names = [...EXPORT_NAMES, ...(opts.extraExports || [])];
  // Guarded export: `typeof X === 'undefined' ? undefined : X` so a build that
  // lacks a name (index.html has no scoreLegs) still loads instead of throwing
  // a ReferenceError that would take the whole surface down with it.
  const exportSuffix = '\n;globalThis.__TUBED__ = {\n' +
    names.map(n => `  ${n}: (typeof ${n} === 'undefined' ? undefined : ${n}),`).join('\n') +
    '\n};';

  const localStorage = makeStorage();
  const ctx = {
    console,
    Date, Math, Object, Array, Set, Map, JSON, Number, String, Boolean, RegExp,
    parseInt, parseFloat, isNaN, isFinite,
    document: makeStub('document'),
    window: makeStub('window'),
    navigator: makeStub('navigator'),
    localStorage,
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: makeStub('location'),
    alert: () => {}, confirm: () => false, prompt: () => null,
    fetch: () => Promise.resolve(makeStub('fetch')),
    setTimeout: () => 0, clearTimeout: () => {},
    setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    IntersectionObserver: class { observe(){} disconnect(){} },
    MutationObserver: class { observe(){} disconnect(){} },
    ResizeObserver: class { observe(){} disconnect(){} },
    performance: { now: () => 0 },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    URL: globalThis.URL,
    URLSearchParams: globalThis.URLSearchParams,
    Promise: globalThis.Promise,
    Error, TypeError, RangeError,
    Symbol, WeakMap, WeakSet,
  };
  Object.assign(ctx, opts.preCtx || {});
  vm.createContext(ctx);

  try {
    vm.runInContext(scripts.join('\n;\n') + exportSuffix, ctx, { filename: abs });
  } catch (e) {
    // The DOM stubs make init() throw harmlessly after the definitions land.
    // Only treat it as fatal if the surface never got attached.
    if (!ctx.__TUBED__) {
      throw new Error(`engine eval failed for ${abs}: ${e.message}`);
    }
  }
  if (!ctx.__TUBED__) throw new Error(`no engine surface exported from ${abs}`);

  const T = ctx.__TUBED__;
  T._ctx = ctx;
  T._path = abs;
  T._localStorage = localStorage;
  return T;
}

/**
 * Every (date, mode) puzzle instance in puzzle-lookup.json — the 280-instance
 * corpus both the beatable-optimal scan and the equivalence diff run over.
 */
export function puzzleInstances() {
  const lookup = JSON.parse(readFileSync(path.join(ROOT, 'puzzle-lookup.json'), 'utf8'));
  const out = [];
  for (const [date, entry] of Object.entries(lookup)) {
    for (const mode of ['easy', 'hard']) {
      const p = entry[mode];
      if (p && p.start && p.end) out.push({ date, mode, start: p.start, end: p.end });
    }
  }
  return out;
}

/** Stable string for a scored route, for cross-build diffing. */
export function fingerprint(route) {
  if (!route) return 'NONE';
  const legs = (route.legs || []).map(l => `${l.line}:${l.from}>${l.to}=${l.mins}`).join('|');
  return `${route.mins}#${legs}`;
}
