'use strict';
/** ADR 0007: adapters follow evidence/*.json exactly — ok → enabled crawl, structured-only → disabled, queued → review queue. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { validateSource } = require('../server/registry');
const { load } = require('../server/config');
const { suite } = require('./helpers');

const t = suite('source-access');
const ROOT = path.join(__dirname, '..');
const evidence = fs.readdirSync(path.join(ROOT, 'evidence')).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(ROOT, 'evidence', f), 'utf8')));
const adapter = (d) => {
    const p = path.join(ROOT, 'adapters', `${d}.json`);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
};
const queue = fs.readFileSync(path.join(ROOT, 'compliance', 'review-queue.yaml'), 'utf8');

t('every evidence file carries a computed verdict', () => {
    assert.ok(evidence.length >= 29);
    for (const e of evidence) assert.ok(['ok', 'structured-only', 'queued'].includes(e.verdict), `${e.domain}: ${e.verdict}`);
});

t('ok → an enabled crawl adapter; structured-only → a disabled one; queued → a review-queue row and no adapter', () => {
    for (const e of evidence) {
        const a = adapter(e.domain);
        if (e.verdict === 'queued') {
            assert.strictEqual(a, null, `${e.domain} is queued and has an adapter`);
            assert.ok(queue.includes(`- domain: ${e.domain}\n`), `${e.domain} missing from the review queue`);
            continue;
        }
        assert.ok(a, `${e.domain} (${e.verdict}) has no adapter`);
        assert.strictEqual(a.type, 'crawl');
        assert.strictEqual(a.enabled, e.verdict === 'ok', `${e.domain}: enabled must follow the verdict`);
        assert.ok(a.terms_note.includes(`evidence/${e.domain}.json`), `${e.domain}: terms_note cites its evidence`);
        assert.ok(a.crawl.require_structured, `${e.domain}: structured surfaces first`);
        validateSource(a);
    }
});

t('no adapter exists without evidence', () => {
    const known = new Set(evidence.map(e => e.domain));
    for (const f of fs.readdirSync(path.join(ROOT, 'adapters'))) assert.ok(known.has(f.replace(/\.json$/, '')), `adapters/${f} has no evidence`);
});

t('the crawler sends the ADR 0007 user agent and answers to both product tokens', () => {
    const { fetch } = load({});
    assert.strictEqual(fetch.userAgent, 'Mozilla/5.0 (compatible; OpenVibeBot/1.0; +https://openvibe.network/bot)');
    assert.deepStrictEqual(fetch.robotsAgent.split(','), ['OpenVibeBot', 'OpenVibeSources']);
});

t.run();
