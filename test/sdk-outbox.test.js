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

t('service_outbox carries events; 0005 is the contract that drops the legacy event_outbox after 0002', async () => {
    const h = await testDb();
    try {
        assert.strictEqual(await h.db.value("SELECT to_regclass('service_outbox') IS NOT NULL"), true);
        // Whether the drop has run depends on the contract window (openvibe-sdk/db holds a contract for 7 days after its
        // expand on a fresh PostgreSQL database; PGlite runs it at once), so the migration itself is what is checked.
        const sql = require('fs').readFileSync(require('path').join(__dirname, '..', 'migrations', '0005_drop_event_outbox.sql'), 'utf8');
        assert.match(sql, /^-- phase: contract\n-- after: 0002\n/);
        assert.match(sql, /DROP TABLE IF EXISTS event_outbox;/);
    } finally { await h.close(); }
});

t.run();
