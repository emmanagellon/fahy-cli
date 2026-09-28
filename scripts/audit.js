// npm run audit — static cross-file checks node --check cannot do:
// every static import must resolve to a real file + a real export
// (catches removed-but-still-imported symbols), and every bare package
// import must be declared in package.json.
import fs from 'node:fs';
import path from 'node:path';

const roots = ['src', 'scripts'];
const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir)) {
    const f = path.join(dir, e).replace(/\\/g, '/');
    if (fs.statSync(f).isDirectory()) walk(f);
    else if (f.endsWith('.js')) files.push(f);
  }
};
for (const r of roots) walk(r);

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const declared = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})]);
const nodeBuiltins = new Set(['fs', 'path', 'os', 'child_process', 'net', 'events', 'util', 'stream', 'crypto', 'timers', 'assert']);
// Globals allowed as `new X()` targets without an import.
const GLOBALS = new Set([
  'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'URL', 'URLSearchParams',
  'AbortController', 'Error', 'TypeError', 'RangeError', 'SyntaxError',
  'Array', 'Object', 'String', 'Number', 'Boolean', 'BigInt', 'RegExp', 'Date',
  'Buffer', 'TextEncoder', 'TextDecoder', 'ArrayBuffer', 'Uint8Array', 'Int32Array',
  'Proxy', 'Reflect', 'Intl', 'Event', 'CustomEvent',
]);
const exportCache = new Map();

// Comments + string literals removed (naive but sufficient): prose and
// example snippets must not count as code. ${} interpolation inside
// template literals goes with them — none of our sources construct names
// there (the audit would tell us if that ever changes: it fails open).
// NOTE: the template pattern is built without a raw backtick literal — a
// backtick inside a /.../ regex poisons the pairing (it matched the inside
// of this very function and shifted every template after it).
const BT = String.fromCharCode(96);
function stripNonCode(src) {
  const tpl = new RegExp(BT + '(?:\\\\.|[^' + BT + '\\\\])*' + BT, 'g');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(tpl, ' ')
    .replace(/'(?:\\.|[^'\\])*'/g, ' ')
    .replace(/"(?:\\.|[^"\\])*"/g, ' ')
    .replace(/(^|[^:/])\/\/[^\n]*/g, '$1 ');
}

function exportsOf(f) {
  if (!exportCache.has(f)) {
    const src = fs.readFileSync(f, 'utf8');
    const names = new Set(
      [...src.matchAll(/export\s+(?:async\s+)?function\s+(\w+)|export\s+(?:const|let|var|class)\s+(\w+)/g)]
        .map((m) => m[1] || m[2])
    );
    for (const m of src.matchAll(/export\s*\{\s*([^}]+)\s*\}/g)) {
      for (const part of m[1].split(',')) {
        const mm = /(\w+)(?:\s+as\s+(\w+))?/.exec(part.trim());
        if (mm) names.add(mm[2] || mm[1]);
      }
    }
    exportCache.set(f, names);
  }
  return exportCache.get(f);
}

let errors = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const dir = path.dirname(f).replace(/\\/g, '/');
  // static imports
  for (const m of src.matchAll(/^import\s+(.+?)\s+from\s*['"]([^'"]+)['"]/gm)) {
    const [, clause, mod] = m;
    if (mod.startsWith('.')) {
      const target = path.normalize(path.join(dir, mod)).replace(/\\/g, '/');
      const tf = target.endsWith('.js') ? target : `${target}.js`;
      if (!fs.existsSync(tf)) {
        console.error(`FAIL ${f}: imports missing file ${mod}`);
        errors += 1;
        continue;
      }
      const names = [];
      const def = /^(\w+)\s*,/.exec(clause.trim());
      if (def) names.push({ n: def[1], def: true });
      const named = /\{([^}]*)\}/.exec(clause);
      if (named) {
        for (const part of named[1].split(',')) {
          const mm = /(\w+)(?:\s+as\s+(\w+))?/.exec(part.trim());
          if (mm) names.push({ n: mm[1], def: false });
        }
      }
      const exps = exportsOf(tf);
      for (const { n, def: isDef } of names) {
        if (isDef) continue; // default imports: structural, skip
        if (!exps.has(n)) {
          console.error(`FAIL ${f}: imports '${n}' but ${tf} does not export it`);
          errors += 1;
        }
      }
    } else if (!mod.startsWith('node:') && !nodeBuiltins.has(mod.split('/')[0])) {
      const base = mod.startsWith('@') ? mod.split('/').slice(0, 2).join('/') : mod.split('/')[0];
      if (!declared.has(base)) {
        console.error(`FAIL ${f}: undeclared dependency '${mod}'`);
        errors += 1;
      }
    }
  }
  // dynamic imports with string literals
  for (const m of src.matchAll(/await import\(['"]([^'"]+)['"]\)/g)) {
    const mod = m[1];
    if (!mod.startsWith('.')) continue;
    const target = path.normalize(path.join(dir, mod)).replace(/\\/g, '/');
    const tf = target.endsWith('.js') ? target : `${target}.js`;
    if (!fs.existsSync(tf)) {
      console.error(`FAIL ${f}: dynamic-imports missing file ${mod}`);
      errors += 1;
    }
  }
  // constructed names must exist: every `new X()` needs X imported, declared
  // top-level, destructured from a dynamic import, or a known global
  // (catches use-before-import like MusicPlayer). Comments and string
  // literals are stripped first so prose ("new TLD", example code in
  // messages) never counts as construction.
  {
    const defined = new Set(GLOBALS);
    for (const m of src.matchAll(/^import\s+(.+?)\s+from\s*['"][^'"]+['"]/gm)) {
      const clause = m[1].trim();
      const ns = /^\*\s+as\s+(\w+)/.exec(clause);
      if (ns) {
        defined.add(ns[1]);
        continue;
      }
      const def = /^(\w+)\s*(,|$)/.exec(clause);
      if (def) defined.add(def[1]);
      const named = /\{([^}]*)\}/.exec(clause);
      if (named) {
        for (const part of named[1].split(',')) {
          const mm = /(\w+)(?:\s+as\s+(\w+))?/.exec(part.trim());
          if (mm) defined.add(mm[2] || mm[1]);
        }
      }
    }
    for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*await\s+import\(/g)) {
      for (const part of m[1].split(',')) {
        const mm = /(\w+)(?:\s*:\s*(\w+))?/.exec(part.trim());
        if (mm) defined.add(mm[2] || mm[1]);
      }
    }
    for (const m of src.matchAll(/^(?:export\s+)?(?:async\s+function\s+(\w+)|(?:const|let|var|class)\s+(\w+))/gm)) {
      defined.add(m[1] || m[2]);
    }
    const code = stripNonCode(src);
    for (const m of code.matchAll(/new\s+([A-Z]\w*)/g)) {
      if (!defined.has(m[1])) {
        console.error(`FAIL ${f}: 'new ${m[1]}()' but ${m[1]} is not imported or declared`);
        errors += 1;
      }
    }
  }
}
console.log(errors ? `${errors} audit error(s).` : 'AUDIT OK — all imports resolve.');
process.exit(errors ? 1 : 0);
