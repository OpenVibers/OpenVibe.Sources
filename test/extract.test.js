'use strict';
/**
 * `extract` on a feed endpoint (server/adapters/extract.js): facts a feed's items state in prose — a coupon code, the
 * shop, the stated end date — read by the source's own patterns. An item that states every required field becomes
 * that kind with those fields; any other item is not this source's. Dates without a year land on or after the item's
 * publication. The registry refuses a broken pattern, an unknown option, or extract on an api source; the seed
 * (dealnews-coupon-codes) reads real DealNews wording.
 */
const assert = require('assert');
const extract = require('../server/adapters/extract');
const { boot, site, sourceDef, rss, suite } = require('./helpers');
const seeds = require('../seeds/sources.json').sources;

const t = suite('extract');
const SEED = seeds.find((s) => s.key === 'dealnews-coupon-codes');
const X = SEED.endpoints[0].extract;
// Real DealNews item text (2026-10-14), one that names no code, and one with a code but no shop.
const ITEMS = [
    { identity: 'd1', kind: 'article', title: 'Bestek 300W DC to AC Car Power Inverter for $19 + free shipping w/ Prime', published_at: '2026-10-14T12:00:00.000Z',
        summary: 'Handy for road trips, and at $19 it\'s $16 below the $35 list price. Apply coupon code "UXBMXG9V" for a savings of $16. Deal ends October 20. Buy Now at Amazon Features 300W continuous', fields: { categories: [] } },
    { identity: 'd2', kind: 'article', title: 'Office 2024', published_at: '2026-10-14T12:00:00.000Z',
        summary: 'DigitalKeysBox offers Microsoft Office Standard 2024 for just $11 when you apply promo code "DEALNEWSOCT11" at checkout. Buy Now at DigitalKeysBox', fields: {} },
    { identity: 'd3', kind: 'article', title: 'A sale', published_at: '2026-10-14T12:00:00.000Z', summary: 'Up to 60% off everything. Buy Now at Harbor Freight', fields: {} },
    { identity: 'd4', kind: 'article', title: 'A code with no shop', published_at: '2026-10-14T12:00:00.000Z', summary: 'Apply coupon code "NOSHOP12" to save.', fields: {} },    { identity: 'd5', kind: 'article', title: 'Shake Shack', published_at: '2026-10-14T12:00:00.000Z', summary: 'Get a free Single Cheeseburger with $10 purchase by applying promo code "SCARYGOOD". Shop Now at Shake Shack', fields: {} },
];

t('the DealNews seed keeps the items that state a code and a shop, with exactly what they state', async () => {
    assert.strictEqual(extract.check(X), null);
    const out = extract.apply(ITEMS, X);
    assert.strictEqual(out.skipped, 2);
    assert.deepStrictEqual(out.items.map((i) => [i.identity, i.kind, i.fields.code, i.fields.merchant, i.fields.expires || null]),
        [['d1', 'coupon', 'UXBMXG9V', 'Amazon', '2026-10-20'], ['d2', 'coupon', 'DEALNEWSOCT11', 'DigitalKeysBox', null], ['d5', 'coupon', 'SCARYGOOD', 'Shake Shack', null]]);
    assert.deepStrictEqual(out.items[0].fields.categories, [], 'the feed\'s own fields stay');
});

t('a stated date without a year lands on or after the item\'s publication', async () => {
    assert.strictEqual(extract.statedDate('October 20', '2026-10-14T00:00:00Z'), '2026-10-20');
    assert.strictEqual(extract.statedDate('January 5', '2026-12-20T00:00:00Z'), '2027-01-05');
    assert.strictEqual(extract.statedDate('Oct. 20, 2027', '2026-10-14T00:00:00Z'), '2027-10-20');
    assert.strictEqual(extract.statedDate('February 30', '2026-01-01T00:00:00Z'), null);
    assert.strictEqual(extract.statedDate('soon', '2026-01-01T00:00:00Z'), null);
});

t('a broken or unknown extract is refused', async () => {
    const bad = [null, [], { kind: 'Coupon', require: ['code'], fields: { code: { from: 'summary', pattern: '(x)' } } },
        { kind: 'coupon', require: ['code'], fields: { code: { from: 'body', pattern: '(x)' } } },
        { kind: 'coupon', require: ['code'], fields: { code: { from: 'summary', pattern: 'no group' } } },
        { kind: 'coupon', require: ['code'], fields: { code: { from: 'summary', pattern: '(unclosed' } } },
        { kind: 'coupon', require: ['other'], fields: { code: { from: 'summary', pattern: '(x)' } } },
        { kind: 'coupon', require: ['code'], fields: { code: { from: 'summary', pattern: '(x)', as: 'number' } } },
        { kind: 'coupon', require: ['code'], fields: { code: { from: 'summary', pattern: '(x)' } }, more: 1 }];
    for (const b of bad) assert.ok(extract.check(b), JSON.stringify(b));
});

t('through the registry and a real run: only coupon items are stored, with their fields', async () => {
    const svc = await boot();
    const body = rss(ITEMS.map((i) => ({ guid: i.identity, title: i.title, link: `https://www.dealnews.example/${i.identity}`, date: 'Wed, 14 Oct 2026 12:00:00 +0000', description: i.summary })));
    const web = await site({ '/robots.txt': () => ({ body: 'User-agent: *\nAllow: /\n' }), '/feed.xml': () => ({ headers: { 'Content-Type': 'application/rss+xml' }, body }) });
    const def = sourceDef({ key: 'coupons-x', category: 'coupons', endpoints: [{ url: `${web.origin}/feed.xml`, extract: X }] });
    await svc.registry.create(def, 'test');
    await assert.rejects(svc.registry.create(sourceDef({ key: 'coupons-y', endpoints: [{ url: `${web.origin}/feed.xml`, extract: { ...X, fields: { code: { from: 'summary', pattern: '(' } } } }] }), 'test'), /pattern/);
    await assert.rejects(svc.registry.create(sourceDef({ key: 'coupons-z', type: 'api', endpoints: [{ url: `${web.origin}/feed.xml`, extract: X }] }), 'test'));
    const out = await svc.ingest.run('coupons-x', { trigger: 'manual' });
    assert.deepStrictEqual(out.runs.map((r) => r.state), ['ok']);
    const rows = await svc.db.prepare("SELECT identity, kind, fields FROM items WHERE source_key = 'coupons-x' ORDER BY identity").all();
    assert.deepStrictEqual(rows.map((r) => [r.identity, r.kind]), [['d1', 'coupon'], ['d2', 'coupon'], ['d5', 'coupon']]);
    const f = typeof rows[0].fields === 'string' ? JSON.parse(rows[0].fields) : rows[0].fields;
    assert.deepStrictEqual([f.code, f.merchant, f.expires], ['UXBMXG9V', 'Amazon', '2026-10-20']);
    const [run] = out.runs;
    assert.strictEqual(run.items_skipped, 2);
    await web.close();
    await svc.stop();
});

t.run();
