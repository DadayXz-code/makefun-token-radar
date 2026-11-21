// Take the entry's three screenshots with a headless Chromium (playwright-core).
// Local tooling only: it is not part of the graded program and never runs in the
// grader's sandbox. Run from the repository root:
//   node scripts/shots.mjs [out-dir]
// The dashboard must already be built into <out-dir> (default out/).
// Screenshots are 1440x900 PNGs: board, detail of rank #1, and a filtered view.
import { chromium } from 'playwright-core';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outDir = resolve(root, process.argv[2] || 'out');
const board = JSON.parse(readFileSync(join(outDir, 'board.json'), 'utf8')).rows;
const top = board[0];
const page_url = (hash) => `file://${join(outDir, 'dashboard', 'index.html')}${hash}`;

const shots = [
  { name: '1-board.png', hash: '#/' },
  { name: '2-detail.png', hash: `#/p/${encodeURIComponent(top.slug)}` },
  { name: '3-filtered.png', hash: '#/?sig=Farm' },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
for (const s of shots) {
  await page.goto(page_url(s.hash), { waitUntil: 'load' });
  await page.waitForSelector('main .wrap', { timeout: 10000 });
  await page.waitForTimeout(400);
  const path = join(root, 'screenshots', s.name);
  await page.screenshot({ path, type: 'png' });
  const bytes = statSync(path).size;
  console.log(`${s.name}: ${bytes} bytes (${(bytes / 1024).toFixed(0)} KiB)${bytes > 524288 ? ' OVER 512 KiB CAP' : ''}`);
}
await browser.close();
if (errors.length > 0) {
  console.error('page errors:', errors.join('\n'));
  process.exit(1);
}
console.log('screenshots done');
