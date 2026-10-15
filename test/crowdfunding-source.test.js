'use strict';
/**
 * opencollective-accounts (seeds/sources.json), category crowdfunding: Open Collective's public GraphQL API read by GET.
 *   - the seed validates, is disabled, and both endpoints send Content-Type: application/json (the API's CSRF guard
 *     refuses a GET without it); no other request content type is accepted;
 *   - each account becomes one campaign item keyed by its slug, with the amounts and counts as the API states them;
 *   - a run against a stub that insists on the header ingests, and the GET carried the header.
 */
const assert = require('assert');
const api = require('../server/adapters/api');
const { validateSource } = require('../server/registry');
const { boot, site, sourceDef, suite } = require('./helpers');

const t = suite('crowdfunding-source');
const seed = require('../seeds/sources.json').sources.find((s) => s.key === 'opencollective-accounts');

const BODY = JSON.stringify({ data: { accounts: { nodes: [
    { slug: 'logseq', name: 'Logseq', type: 'COLLECTIVE', description: 'A privacy-first platform.', currency: 'USD', createdAt: '2020-09-22T10:40:25.537Z',
        imageUrl: 'https://images.opencollective.com/logseq/logo.png', website: 'https://logseq.com/', tags: ['knowledge-base'],
        stats: { totalAmountReceived: { valueInCents: 95659957, currency: 'USD' }, yearlyBudget: { valueInCents: 23811274, currency: 'USD' }, contributorsCount: 12182 } },
    { slug: 'tiny', name: 'Tiny Project', type: 'PROJECT', description: null, currency: 'EUR', createdAt: '2026-10-14T08:00:00Z', imageUrl: null, website: null, tags: [],
        stats: { totalAmountReceived: { valueInCents: 0, currency: 'EUR' }, yearlyBudget: { valueInCents: 0, currency: 'EUR' }, contributorsCount: 0 } },
] } } });

t('the seed is a disabled crowdfunding api source whose GETs carry Content-Type: application/json', () => {
    assert.ok(seed, 'opencollective-accounts is seeded');
    const rec = validateSource(seed);
    assert.strictEqual(rec.enabled, false);
    assert.strictEqual(rec.category, 'crowdfunding');
    assert.strictEqual(rec.endpoints.length, 2);
    for (const ep of rec.endpoints) assert.strictEqual(ep.request_content_type, 'application/json');
    assert.throws(() => validateSource({ ...seed, endpoints: [{ ...seed.endpoints[0], request_content_type: 'text/plain' }] }), /request_content_type may only be application\/json/);
    assert.throws(() => validateSource(sourceDef({ type: 'rss', endpoints: [{ url: 'https://example.org/f.xml', request_content_type: 'application/json' }] })), /only for api sources/);
});

t('each account is one campaign item keyed by slug, amounts as the API states them', () => {
    const r = api.parse(BODY, { url: seed.endpoints[0].url, endpoint: seed.endpoints[0], maxItems: seed.max_items });
    assert.strictEqual(r.items.length, 2);
    const [logseq, tiny] = r.items;
    assert.deepStrictEqual([logseq.identity, logseq.kind, logseq.title, logseq.published_at], ['logseq', 'campaign', 'Logseq', '2020-09-22T10:40:25.537Z']);
    assert.deepStrictEqual(logseq.fields, {
        slug: 'logseq', account_type: 'COLLECTIVE', currency: 'USD', raised_cents: 95659957, raised_currency: 'USD', yearly_budget_cents: 23811274,
        backers: 12182, image_url: 'https://images.opencollective.com/logseq/logo.png', website: 'https://logseq.com/', tag: 'knowledge-base',
    });
    assert.deepStrictEqual([tiny.summary, tiny.fields.tag, tiny.fields.website], [null, null, null], 'missing values stay null');
});

t('a run sends the header and ingests what the API answered', async () => {
    const svc = await boot();
    const s = await site({
        '/robots.txt': () => ({ status: 404, body: 'Not Found' }),
        '/graphql/v2': (req) => (String(req.headers['content-type'] || '').startsWith('application/json')
            ? { headers: { 'Content-Type': 'application/json' }, body: BODY }
            : { status: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ errors: [{ message: 'blocked as a potential CSRF' }] }) }),
    });
    try {
        const ep = { ...seed.endpoints[0], url: `${s.origin}/graphql/v2?query=x` };
        await svc.registry.create(sourceDef({ key: 'oc', type: 'api', category: 'crowdfunding', endpoints: [ep] }), 'test');
        const r = await svc.ingest.run('oc', { trigger: 'manual' });
        assert.deepStrictEqual([r.runs[0].state, r.runs[0].items_seen], ['ok', 2]);
        assert.strictEqual(s.hits('/graphql/v2')[0].headers['content-type'], 'application/json');
        const rows = await svc.db.prepare("SELECT identity, category, kind FROM items WHERE source_key = 'oc' ORDER BY identity").all();
        assert.deepStrictEqual(rows.map((x) => [x.identity, x.category, x.kind]), [['logseq', 'crowdfunding', 'campaign'], ['tiny', 'crowdfunding', 'campaign']]);
    } finally { await s.close(); await svc.stop(); }
});

t.run();
