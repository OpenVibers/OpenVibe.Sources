#!/usr/bin/env node
// ADR 0007: build each source's adapter (or review-queue row) from evidence/<domain>.json only, and print one line per
// source: verdict, statuses, lane, adapter path. The verdict is the probe's; nothing here re-judges it.
//   ok              → adapters/<domain>.json, a crawl source, enabled (structured surfaces first: sitemaps, JSON-LD)
//   structured-only → adapters/<domain>.json, disabled: Lane 1 (feeds, affiliate, official API, merchant opt-in)
//   queued          → compliance/review-queue.yaml row; probed again ≥ 24 h later (two attempts)
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';

const terms = new Map();   // terms-of-use quotes on file (research 2026-10-28), carried into license_note as a record
try {
    for (const c of JSON.parse(await readFile(process.env.CANDIDATES || '/dev/null', 'utf8').catch(() => '[]'))) {
        const q = c.terms && c.terms.quotes && c.terms.quotes[0];
        if (q) terms.set(c.site, `${c.terms.url}: "${String(q).slice(0, 300)}"`);
    }
} catch { /* no research file: nothing to carry */ }

const key = (d) => `crawl-${d.replace(/^www\./, '').replace(/[^a-z0-9]+/g, '-')}`.slice(0, 63);
const status = (e, p) => (e.attempted.find((a) => a.url.endsWith(p)) || {}).status;
const ok = (s) => s >= 200 && s < 400;

await mkdir('adapters', { recursive: true });
await mkdir('compliance', { recursive: true });
const queue = [];
const lines = [];
for (const f of (await readdir('evidence')).filter((x) => x.endsWith('.json')).sort()) {
    const e = JSON.parse(await readFile(`evidence/${f}`, 'utf8'));
    const statuses = e.attempted.map((a) => `${new URL(a.url).pathname}:${a.status}${a.challenged ? 'c' : ''}`).join(' ');
    if (e.verdict === 'queued') {
        const next = new Date(Date.parse(e.at) + 24 * 3600e3).toISOString();
        queue.push({ domain: e.domain, verdict: 'queued', first_probe: e.at, next_probe_after: next, attempts: 1, statuses });
        lines.push(`${e.domain} · queued · ${statuses} · review queue (probe again after ${next}) · compliance/review-queue.yaml`);
        continue;
    }
    const sitemap = ok(status(e, '/sitemap.xml'));
    const enabled = e.verdict === 'ok';
    const surfaces = ['/sitemap.xml', '/products.json', '/llms.txt', '/api/'].filter((p) => ok(status(e, p)));
    const src = {
        key: key(e.domain),
        name: `${e.domain} (crawl)`,
        type: 'crawl',
        category: 'deals',
        homepage_url: `https://${e.domain}/`,
        endpoints: [`https://${e.domain}/`],
        crawl: sitemap
            ? { sitemaps: true, follow_links: false, require_structured: true, max_pages: 2000, pages_per_run: 50, recrawl_sec: 86400 }
            : { sitemaps: true, follow_links: true, max_depth: 2, require_structured: true, max_pages: 2000, pages_per_run: 50, recrawl_sec: 86400 },
        min_interval_ms: 5000,
        poll_interval_sec: 3600,
        robots_note: `robots.txt answered ${status(e, '/robots.txt')} at ${e.at} (evidence/${f}); every request and redirect hop is checked against it (RFC 9309, tokens OpenVibeBot and OpenVibeSources).`,
        terms_note: `Access verdict "${e.verdict}" per ADR 0007, computed from evidence/${f} (${e.at}). Structured surfaces answering: ${surfaces.join(', ') || 'none'}.`
            + (enabled ? '' : ' Lane 1 only: feeds, affiliate programs, official APIs or merchant opt-in; this crawl adapter stays disabled.'),
        license_note: terms.has(e.domain) ? `Terms of use on file: ${terms.get(e.domain)}` : null,
        enabled,
        review_required: true,
        default_indexability: 'noindex',
    };
    if (!src.license_note) delete src.license_note;
    await writeFile(`adapters/${e.domain}.json`, JSON.stringify(src, null, 2) + '\n');
    lines.push(`${e.domain} · ${e.verdict} · ${statuses} · ${enabled ? 'adapter enabled' : 'Lane 1 (adapter disabled)'} · adapters/${e.domain}.json`);
}
const yaml = ['# ADR 0007 review queue: sources with nothing under 400. A second probe ≥ 24 h after the first decides; until then', '# no adapter exists. Written by scripts/adapters-from-evidence.mjs from evidence/*.json.', 'queue:']
    .concat(queue.flatMap((q) => [`  - domain: ${q.domain}`, `    verdict: ${q.verdict}`, `    attempts: ${q.attempts}`, `    first_probe: ${q.first_probe}`,
        `    next_probe_after: ${q.next_probe_after}`, `    statuses: "${q.statuses}"`]));
await writeFile('compliance/review-queue.yaml', yaml.join('\n') + '\n');
console.log(lines.join('\n'));
