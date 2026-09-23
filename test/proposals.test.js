'use strict';
/**
 * Proposals for OpenVibe.Contracts are valid against the contracts' own schemas; what the API
 * returns matches the proposed sources.source@1 / sources.item@1; the seeds are honest.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const contracts = require('openvibe-contracts');
const { CAPS } = require('../server/auth');
const { validateSource, CATEGORIES } = require('../server/registry');
const { seed } = require('../scripts/seed');
const { boot, request, serviceToken, site, sourceDef, rss, suite } = require('./helpers');

const t = suite('proposals');
const DOCS = path.join(__dirname, '..', 'docs');
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const schema = (name) => ajv.compile(JSON.parse(fs.readFileSync(path.join(DOCS, 'contracts-proposal', 'contracts', 'sources', name), 'utf8')));
const sourceSchema = schema('source.v1.json');
const itemSchema = schema('item.v1.json');

t('capability proposals are valid capabilities.capability@1 and cover every enforced id', () => {
    const dir = path.join(DOCS, 'capabilities-proposal');
    const ids = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map((f) => {
        const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const v = contracts.validate('capabilities.capability@1', m);
        assert.ok(v.valid, `${f}: ${JSON.stringify(v.errors)}`);
        assert.strictEqual(`${m.id}.json`, f);
        return m.id;
    });
    assert.deepStrictEqual(ids.sort(), Object.values(CAPS).sort());
});

t('the service manifest proposal is a valid registry.service-manifest@1', () => {
    const m = JSON.parse(fs.readFileSync(path.join(DOCS, 'service-manifest-proposal.json'), 'utf8'));
    const v = contracts.validate('registry.service-manifest@1', m);
    assert.ok(v.valid, JSON.stringify(v.errors));
    assert.deepStrictEqual([...m.capabilities].sort(), Object.values(CAPS).sort());
});

t('seeds: one real source per category, all disabled, all valid, notes recorded', () => {
    const seeds = require('../seeds/sources.json').sources;
    assert.deepStrictEqual(seeds.map(s => s.category).sort(), [...CATEGORIES].sort());
    for (const s of seeds) {
        const rec = validateSource(s);
        assert.strictEqual(rec.enabled, false, s.key);
        assert.ok(rec.terms_note, `${s.key} has a terms note`);
        if (rec.type !== 'manual') assert.ok(rec.robots_note, `${s.key} has a robots note`);
        assert.strictEqual(rec.default_indexability, 'noindex');
        for (const ep of rec.endpoints) assert.ok(ep.url.startsWith('https://'), ep.url);
        assert.ok(sourceSchema(rec), JSON.stringify(sourceSchema.errors));
    }
    const { openDb } = require('../server/db');
    const db = openDb(':memory:');
    assert.strictEqual(seed(db).created.length, seeds.length);
    assert.deepStrictEqual(seed(db).created, [], 'never overwrites');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM sources WHERE enabled = 1').get().n, 0);
    db.close();
});

t('API views match sources.source@1 and sources.item@1', async () => {
    const svc = await boot();
    const web = await site({ '/robots.txt': () => ({ status: 404 }), '/f': () => ({ body: rss([{ guid: 'p1', title: 'P', link: 'https://example.org/p' }]) }) });
    try {
        const admin = serviceToken('network', ['sources.*']);
        await request(svc.base, 'POST', '/api/v1/sources', { token: admin, body: sourceDef({ key: 'proposal-check', endpoints: [`${web.origin}/f`] }) });
        await request(svc.base, 'POST', '/api/v1/sources/proposal-check/fetch', { token: admin });
        const src = await request(svc.base, 'GET', '/api/v1/sources/proposal-check', { token: admin });
        assert.ok(sourceSchema(src.body.source), JSON.stringify(sourceSchema.errors));
        const items = await request(svc.base, 'GET', '/api/v1/items', { token: admin });
        for (const it of items.body.items) assert.ok(itemSchema(it), JSON.stringify(itemSchema.errors));
        const one = await request(svc.base, 'GET', `/api/v1/items/${items.body.items[0].id}?revisions=1`, { token: admin });
        assert.ok(itemSchema(one.body.item), JSON.stringify(itemSchema.errors));
    } finally { await svc.stop(); await web.close(); }
});

t.run();
