'use strict';
/**
 * porkbun-domain-pricing (seeds/sources.json): Porkbun's public pricing call answers { pricing: { "<tld>": {
 * registration, renewal, transfer, coupons } } }, so the seed reads it as a map: one domain_price item per TLD keyed by
 * the TLD, with the three prices exactly as stated (strings, US dollars). Coupons are not carried.
 */
const assert = require('assert');
const api = require('../server/adapters/api');
const { validateSource } = require('../server/registry');
const { suite } = require('./helpers');

const t = suite('porkbun-pricing');
const seed = require('../seeds/sources.json').sources.find((s) => s.key === 'porkbun-domain-pricing');
const BODY = JSON.stringify({ status: 'SUCCESS', pricing: {
    com: { registration: '11.08', renewal: '11.08', transfer: '11.08', coupons: [] },
    'co.uk': { registration: '6.05', renewal: '6.05', transfer: '6.05', coupons: [{ code: 'X', max_per_user: 1 }] },
} });

t('the seed is a disabled, daily hosting source of domain_price items that validates', () => {
    assert.ok(seed);
    const rec = validateSource(seed);
    assert.strictEqual(rec.enabled, false);
    assert.strictEqual(rec.category, 'hosting');
    assert.strictEqual(rec.poll_interval_sec, 86400);
});

t('one item per TLD, keyed by it, the prices as stated and no coupons', () => {
    const r = api.parse(BODY, { url: seed.endpoints[0].url, endpoint: seed.endpoints[0], maxItems: seed.max_items });
    assert.deepStrictEqual(r.items.map((i) => i.identity), ['co.uk', 'com']);
    const com = r.items.find((i) => i.identity === 'com');
    assert.strictEqual(com.kind, 'domain_price');
    assert.deepStrictEqual(com.fields, { tld: 'com', registration: '11.08', renewal: '11.08', transfer: '11.08' });
});

t.run();
