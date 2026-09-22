// npm run check — syntax-check every project source file.
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const roots = ['src', 'scripts'];
const files = [];
const walk = (dir) => {
  if (!existsSync(dir)) {
    console.error(`SKIP ${dir} (missing)`);
    return;
  }
  for (const e of readdirSync(dir)) {
    if (e.startsWith('.')) continue;
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f);
    else if (f.endsWith('.js')) files.push(f);
  }
};
for (const r of roots) walk(r);

let bad = 0;
for (const f of files.sort()) {
  const r = spawnSync(process.execPath, ['--check', f], { stdio: 'pipe', shell: false });
  if (r.status !== 0) {
    bad += 1;
    console.error(`FAIL ${f}\n${Buffer.from(r.stderr || []).toString('utf8')}`);
  }
}
console.log(bad ? `${bad} file(s) failed.` : `OK — ${files.length} files checked.`);
process.exit(bad ? 1 : 0);
