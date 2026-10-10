'use strict';
/** The Sources migration and SDK outbox, without a loopback server. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createServiceOutbox } = require('openvibe-sdk/events');
const { createMockPlatform } = require('openvibe-sdk/testing');
const { validate } = require('openvibe-contracts');
const { createEnvelope } = require('../server/events/envelope');
const { load } = require('../server/config');
const { start } = require('../server/index');
const { testDb } = require('./db');
const { suite } = require('./helpers');

const t = suite('sdk-outbox');
const types = require('../docs/service-manifest-proposal.json').eventsProduced;
const args = { event_type: 'sources.item.created', subject: { type: 'item', id: 'itm_test', revision: 1 }, payload: { item_id: 'itm_test' } };
const envelope = () => createEnvelope(args, { source: 'sources', now: () => Date.now() });
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

t('the expand migration copies a legacy pending row and the SDK relays it with a service token', async () => {
    const h = await testDb();
    try {
        const env = envelope();
        await h.db.query('INSERT INTO event_outbox (event_id, event_type, envelope, created_at) VALUES ($1, $2, $3, $4)',
            [env.event_id, env.event_type, JSON.stringify(env), Date.now()]);
        const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '0002_sdk_outbox.sql'), 'utf8');
        await h.db.query(migration);
        const copied = await h.db.one('SELECT envelope FROM service_outbox WHERE event_id = $1', [env.event_id]);
        assert.deepStrictEqual(copied.envelope, env);
        const p = platform();
        const out = make(h.db, p);
        assert.strictEqual((await out.status()).pending, 1);
        assert.deepStrictEqual(await out.outbox.flush(), { sent: 1, failed: 0, rejected: 0 });
        assert.strictEqual((await out.status()).pending, 0);
        assert.strictEqual(p.state.events[0].event.event_id, env.event_id);
        assert.ok(p.stats.tokenRequests > 0);
    } finally { await h.close(); }
});

t.run();
