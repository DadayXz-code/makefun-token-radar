// Local gate check for the token-radar entry (the competition has no local grade:
// the server grades every entry, so this script replays the gate's seven rows from
// RULES.txt against a built /output, plus the determinism the grader requires).
// Run from the repository root:  node scripts/check.mjs [out-dir]
// Exits 1 on any failure. It runs main.ts twice into scratch directories and
// requires both runs to write byte-identical outputs.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from '../vendor/makefun-board.ts';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outDir = resolve(root, process.argv[2] || 'out');
const snap = JSON.parse(readFileSync(join(root, '..', '..', 'kits', 'token-radar-01-kit', 'input', 'snapshot.json'), 'utf8'));
const failures = [];
const notes = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

// ---- determinism: two fresh runs must write the same bytes -----------------
const tmpA = join(root, '.check-a');
const tmpB = join(root, '.check-b');
for (const d of [tmpA, tmpB]) { rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); }
const kitInput = join(root, '..', '..', 'kits', 'token-radar-01-kit', 'input', 'snapshot.json');
execFileSync('node', ['main.ts', '--input', kitInput], { cwd: root, env: { ...process.env, MAKEFUN_OUTPUT_DIR: tmpA }, stdio: 'pipe' });
execFileSync('node', ['main.ts', '--input', kitInput], { cwd: root, env: { ...process.env, MAKEFUN_OUTPUT_DIR: tmpB }, stdio: 'pipe' });
function tree(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) for (const f of tree(p)) out.push(join(name, f));
    else out.push(name);
  }
  return out;
}
const filesA = tree(tmpA);
const filesB = tree(tmpB);
let detOk = JSON.stringify(filesA) === JSON.stringify(filesB);
for (const f of filesA) {
  if (sha256(readFileSync(join(tmpA, f))) !== sha256(readFileSync(join(tmpB, f)))) { detOk = false; notes.push(`differ: ${f}`); }
}
check('determinism (two runs, byte-identical)', detOk, detOk ? `${filesA.length} files` : notes.join('; '));

// ---- the built output under check -------------------------------------------
const out = outDir;
const dashDir = join(out, 'dashboard');
const shotDir = join(out, 'screenshots');
const dashFiles = existsSync(dashDir) ? readdirSync(dashDir).filter((f) => statSync(join(dashDir, f)).isFile()) : [];
const dashBytes = dashFiles.reduce((s, f) => s + statSync(join(dashDir, f)).size, 0);
const hasHtml = dashFiles.some((f) => f === 'index.html');
const hasCss = dashFiles.some((f) => f.endsWith('.css'));
const hasJs = dashFiles.some((f) => f.endsWith('.js'));
const nameOk = (n) => /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(n);
let netRef = null;
for (const f of dashFiles) {
  const text = readFileSync(join(dashDir, f), 'utf8');
  if (/(?:src|href)\s*=\s*["']https?:\/\//i.test(text)) netRef = `${f}: http(s) in an attribute`;
  if (/import\s+[^'"]*['"]https?:\/\//.test(text) || /from\s+['"]https?:\/\//.test(text)) netRef = `${f}: http(s) in a JS import`;
  if (/url\(\s*['"]?https?:\/\//.test(text)) netRef = `${f}: http(s) in CSS`;
}
check('dashboard_files', hasHtml && hasCss && hasJs && dashFiles.length <= 400 && dashBytes <= 4_194_304 && dashFiles.every(nameOk) && netRef === null,
  `${dashFiles.length} files, ${dashBytes} bytes${netRef ? `; ${netRef}` : ''}`);
notes.push(`dashboard source total ${dashBytes} bytes (dossier text cap 65536: ${dashBytes <= 65536 ? 'fits whole' : 'OVER — judge reads a cut source'})`);

const boardRaw = readFileSync(join(out, 'board.json'));
const board = JSON.parse(boardRaw.toString('utf8'));
const rows = Array.isArray(board) ? board : board.rows;
const slugs = new Set(snap.protocols.map((p) => p.slug));
const badSlugs = rows.filter((r) => !slugs.has(r.slug)).slice(0, 3).map((r) => r.slug);
const rowsOk = rows.length >= 100 && rows.length <= 4000 && boardRaw.length <= 8 * 1024 * 1024 && badSlugs.length === 0 &&
  rows.every((r) => typeof r.name === 'string' && r.name.length > 0 && Number.isSafeInteger(r.rank) && r.rank > 0 &&
    Number.isSafeInteger(r.implied_value_usd) && r.implied_value_usd > 0 && r.implied_value_usd <= 1e14 && Array.isArray(r.farm_steps));
check('board_file', rowsOk, `${rows.length} rows, ${boardRaw.length} bytes${badSlugs.length ? `; invented slugs: ${badSlugs.join(', ')}` : ''}`);

const ranks = rows.map((r) => r.rank).sort((a, b) => a - b);
let sortedOk = rows.length >= 2 && rows[0].implied_value_usd !== rows[rows.length - 1].implied_value_usd;
for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) sortedOk = false;
for (let i = 1; i < rows.length; i++) if (rows[i].implied_value_usd > rows[i - 1].implied_value_usd) sortedOk = false;
check('sorted_by_value', sortedOk, `ranks 1..${rows.length}, implied $${rows[0].implied_value_usd} down to $${rows[rows.length - 1].implied_value_usd}`);

const rowSlugs = new Set(rows.map((r) => r.slug));
const missing = snap.watchlist.filter((s) => !rowSlugs.has(s));
check('coverage', missing.length === 0, `${snap.watchlist.length - missing.length}/${snap.watchlist.length} watchlist slugs covered${missing.length ? `; missing: ${missing.slice(0, 5).join(', ')}` : ''}`);

const stepsOk = rows.every((r) => r.farm_steps.length >= 3 && r.farm_steps.length <= 12 &&
  r.farm_steps.every((s) => { const t = s.trim(); return t.length >= 20 && t.length <= 600; }));
check('farm_steps', stepsOk, `${rows.length} rows x ${rows[0].farm_steps.length} steps`);

function pngDims(buf) {
  if (buf.length < 33 || buf.readUInt32BE(12) !== 0x49484452) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}
function jpegDims(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}
const shots = existsSync(shotDir) ? readdirSync(shotDir).filter((f) => !f.startsWith('.') && statSync(join(shotDir, f)).isFile()) : [];
let shotsOk = shots.length >= 3 && shots.length <= 4;
let shotDetail = [];
for (const f of shots) {
  const buf = readFileSync(join(shotDir, f));
  const isPng = buf[0] === 0x89 && buf[1] === 0x50;
  const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
  const dims = isPng ? pngDims(buf) : isJpg ? jpegDims(buf) : null;
  const ok = nameOk(f) && buf.length <= 524288 && dims !== null && Math.max(dims.w, dims.h) <= 1440 && Math.min(dims.w, dims.h) >= 800;
  if (!ok) shotsOk = false;
  shotDetail.push(`${f} ${buf.length}B ${dims ? `${dims.w}x${dims.h}` : 'unreadable'}`);
}
check('screenshots', shotsOk, shotDetail.join('; '));

const dossierRaw = readFileSync(join(out, 'dossier.json'));
const rebuilt = buildDossier(out, { text_max_bytes: 65536, screenshots: { max: 4, max_bytes: 524288 }, dashboard: { max_files: 400, max_bytes: 4194304 } });
const dossierObj = JSON.parse(dossierRaw.toString('utf8'));
check('dossier_matches', Buffer.from(rebuilt).equals(dossierRaw) && dossierRaw.length <= 1.5 * 1024 * 1024,
  `dossier ${dossierRaw.length} bytes, text ${Buffer.byteLength(dossierObj.text)} bytes, ${dossierObj.images.length} images`);

// ---- data.js agrees with board.json ------------------------------------------
const dataText = readFileSync(join(out, 'data.js'), 'utf8');
const dataJson = JSON.parse(dataText.replace(/^window\.RADAR=/, '').replace(/;\s*$/, ''));
const dataOk = dataJson.rows.length === rows.length &&
  dataJson.rows.every((r, i) => r.slug === rows[i].slug && r.implied_value_usd === rows[i].implied_value_usd);
check('data.js agrees with board.json', dataOk, `${dataJson.rows.length} rows`);

console.log(failures.length === 0 ? 'ALL GATE ROWS PASS' : `FAILURES: ${failures.join(', ')}`);
for (const n of notes) console.log(`note: ${n}`);
rmSync(tmpA, { recursive: true, force: true });
rmSync(tmpB, { recursive: true, force: true });
process.exit(failures.length === 0 ? 0 : 1);
