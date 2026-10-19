// ============================================================
// markedManifest.mjs — a bench manifest from a folder of marked plans.
//
//   node scripts/markedManifest.mjs <folder> manifest.json [samples/marked-jobs.json]
//
// One sheet per page that carries two or more measured areas (an estimator's
// Bluebeam takeoff: scripts/markedKeys.mjs). Pages the jobs list skips (an
// interior elevation's backsplash, measured on the wall) are left out.
// ============================================================
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readMarkedKeys, areaItems } from './markedKeys.mjs';

const [dir, out, jobsPath = 'samples/marked-jobs.json'] = process.argv.slice(2);
if (!dir || !out) { console.error('usage: node scripts/markedManifest.mjs <folder> manifest.json [jobs.json]'); process.exit(2); }
const jobs = existsSync(jobsPath) ? JSON.parse(readFileSync(jobsPath, 'utf8')).jobs : [];
const skipOf = (slug) => new Set(jobs.find((j) => j.slug === slug)?.skip || []);

const sheets = [];
for (const f of readdirSync(dir).filter((x) => x.toLowerCase().endsWith('.pdf')).sort()) {
  const slug = f.replace(/\.pdf$/i, '');
  let pages;
  try { pages = await readMarkedKeys(new Uint8Array(readFileSync(join(dir, f)))); } catch (e) { console.log(`${f}: unreadable (${e.message})`); continue; }
  const skip = skipOf(slug);
  for (const p of pages) {
    const areas = areaItems(p.items);
    if (areas.length < 2 || skip.has(p.page)) continue;
    sheets.push({ name: `${slug} p${p.page}`, pdf: resolve(dir, f), page: p.page, marked: true });
    console.log(`${f} p${p.page}: ${areas.length} areas, ${areas.reduce((s, a) => s + a.sf, 0).toFixed(0)} SF`);
  }
}
writeFileSync(out, JSON.stringify({ sheets }, null, 1));
console.log(`${sheets.length} sheets → ${out}`);
