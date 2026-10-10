'use strict';
/**
 * The seed file is honest. Every entry in seeds/sources.json passes the registry's own validation
 * (validateSource, registered through the create path too), every entry is DISABLED — seeding is
 * never permission to fetch — and every endpoint is https. Mirrors test/proposals.test.js, which
 * checks the seeds from the contract side.
 *
 *   node test/seeds.test.js
 */
const assert = require('assert');
const { validateSource, createRegistry } = require('../server/registry');
const { suite } = require('./helpers');

const t = suite('seeds');
const seeds = require('../seeds/sources.json').sources;

t('seeds/sources.json is a non-empty list of uniquely keyed sources', () => {
    assert.ok(Array.isArray(seeds) && seeds.length > 0, 'seeds must be a non-empty array');
    const keys = seeds.map((s) => s.key);
    assert.strictEqual(new Set(keys).size, keys.length, 'seed keys must be unique');
});

t('every seed validates, is disabled, and keys only https endpoints', () => {
    for (const s of seeds) {
        const rec = validateSource(s);                                   // throws on any invalid entry
        assert.strictEqual(rec.enabled, false, `${s.key} must be disabled`);
        assert.strictEqual(rec.review_required, true, `${s.key} must require review`);
        assert.strictEqual(rec.default_indexability, 'noindex', `${s.key} must default to noindex`);
        for (const ep of rec.endpoints) assert.ok(ep.url.startsWith('https://'), `${s.key}: endpoint must be https: ${ep.url}`);
    }
});

t('every seed creates through the registry and stays disabled', async () => {
    const fresh = await require('./db').testDb();
    try {
        const registry = createRegistry({ db: fresh.db });
        for (const s of seeds) {
            const row = await registry.create(s, 'seed');                // the real create path, not just validation
            assert.strictEqual(Boolean(row.enabled), false, `${s.key} must be created disabled`);
        }
        const enabled = await fresh.db.prepare('SELECT COUNT(*) AS n FROM sources WHERE enabled = 1').get();
        assert.strictEqual(enabled.n, 0, 'seeding must never enable a source');
    } finally {
        await fresh.close();
    }
});

t.run();
