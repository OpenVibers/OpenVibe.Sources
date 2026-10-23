'use strict';
/** The Sources migration and SDK outbox, without a loopback server. */
const assert = require('assert');
const { createServiceOutbox } = require('openvibe-sdk/events');
const { createMockPlatform } = require('openvibe-sdk/testing');
const { validate } = require('openvibe-contracts');
const { load } = require('../server/config');
const { start } = require('../server/index');
const { testDb } = require('./db');
const { suite } = require('./helpers');

const t = suite('sdk-outbox');
const types = require('../docs/service-manifest-proposal.json').eventsProduced;
const make = (db, platform, secret = 'test-secret') => createServiceOutbox({
    db, source: 'sources', eventsUrl: 'https://openvibe.events', networkInternalUrl: 'https://openvibe.network',
    clientId: 'sources', clientSecret: secret, table: 'service_outbox', eventTypes: types,
    validate: (env) => validate('events.event-envelope@1', env), fetch: platform.fetch,
    log: { warn() {}, log() {} },
});
const platform = () => createMockPlatform({ clients: { sources: { secret: 'test-secret', grants: [['events.event.publish', 'openvibe.events']] } } });

t('an event exists exactly when its change commits; rows wait while delivery is off', async () => {
    const h = await testDb();
    let svc;
    try {
        const p = platform();
        const config = load({ NODE_ENV: 'test', SOURCES_WORKER: 'off' });
        svc = await start({ config, db: h.db, fetchImpl: p.fetch, listen: false, log: { warn() {}, log() {}, error() {} } });
        const source = { key: 'unit', category: 'news', search_visibility: null, license_note: null, terms_note: 'test' };
        const item = (identity) => ({ identity, kind: 'article', canonical_url: `https://example.org/${identity}`, title: identity, authors: [], fields: {} });
        const ctx = { retrievedAt: Date.now(), parserVersion: 'test' };
        await assert.rejects(h.db.tx(async () => {
            await svc.items.ingest(source, [item('rollback')], ctx);
            throw new Error('rollback');
        }), /rollback/);
        assert.strictEqual(await h.db.value('SELECT count(*) FROM items'), 0);
        assert.strictEqual((await svc.outbox.status()).pending, 0);
        await h.db.tx(async () => {
            await svc.items.ingest(source, [item('commit')], ctx);
        });
        assert.strictEqual(await h.db.value('SELECT count(*) FROM items'), 1);
        assert.strictEqual((await svc.outbox.status()).pending, 1);
        assert.strictEqual(p.state.events.length, 0);
    } finally { if (svc) await svc.close(); await h.close(); }
});

t('the legacy event_outbox is gone (0005, after the expand that moved its pending rows); service_outbox carries events', async () => {
    const h = await testDb();
    try {
        assert.strictEqual(await h.db.value("SELECT to_regclass('public.event_outbox') IS NULL"), true, 'event_outbox was dropped');
        assert.strictEqual(await h.db.value("SELECT to_regclass('public.service_outbox') IS NOT NULL"), true);
    } finally { await h.close(); }
});

t.run();
