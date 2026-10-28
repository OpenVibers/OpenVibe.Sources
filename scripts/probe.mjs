#!/usr/bin/env node
// Probe a domain: robots, structured surfaces, then a page fetch.
// Writes evidence/<domain>.json with statuses and a COMPUTED verdict.
import { writeFile, mkdir } from 'node:fs/promises';

const UA = 'Mozilla/5.0 (compatible; OpenVibeBot/1.0; +https://openvibe.network/bot)';
const HDRS = {
  'user-agent': UA,
  accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none',
};
const STRUCTURED = ['/robots.txt', '/sitemap.xml', '/products.json', '/llms.txt', '/api/'];

const domain = process.argv[2];
if (!domain) { console.error('usage: probe.mjs <domain>'); process.exit(1); }

const get = async (url) => {
  try {
    const r = await fetch(url, { headers: HDRS, redirect: 'follow',
      signal: AbortSignal.timeout(15000) });
    // a 200 with a challenge body still counts as challenged
    const body = await r.text();
    const challenged = /just a moment|cf-chl|datadome|captcha/i.test(body.slice(0, 4000));
    return { url, status: r.status, challenged, bytes: body.length };
  } catch (e) { return { url, status: 0, error: String(e.name) }; }
};

const results = [];
for (const p of STRUCTURED) results.push(await get(`https://${domain}${p}`));
results.push(await get(`https://${domain}/`));

const structuredOk = results.slice(0, 5).some(r => r.status >= 200 && r.status < 400);
const page = results.at(-1);
const pageOk = page.status >= 200 && page.status < 400 && !page.challenged;
const okCount = results.filter(r => r.status >= 200 && r.status < 400).length;

const verdict = !okCount ? 'queued'
  : pageOk ? 'ok'
  : structuredOk ? 'structured-only'
  : 'queued';

await mkdir('evidence', { recursive: true });
await writeFile(`evidence/${domain}.json`, JSON.stringify(
  { domain, at: new Date().toISOString(), attempted: results, verdict }, null, 2));
console.log(domain, '→', verdict);
