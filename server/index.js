'use strict';
/**
 * OpenVibe.Sources entry point.
 *
 *   node server/index.js            (systemd: openvibe-sources.service)
 *
 * start() is also what the tests use: it takes a config (server/config.js load()) plus injectable
 * clock/fetch/log/DNS lookup, and returns handles to every part.
 */
const { load } = require('./config');
const { openDb } = require('./db');
const { createRegistry } = require('./registry');
const { createItems } = require('./items');
const { createGuard } = require('./net/guard');
const { createFetcher } = require('./net/fetcher');
const { createSpacer } = require('./spacer');
const { createRobots } = require('./robots');
const { createIngest } = require('./ingest');
const { createScheduler } = require('./scheduler');
const { createServiceOutbox } = require('openvibe-sdk/events');
const { validate } = require('openvibe-contracts');
const { createEnvelope } = require('./events/envelope');
const manifest = require('../docs/service-manifest-proposal.json');
const { jwksClient } = require('openvibe-sdk/auth');
const { gracefulStop, telemetry } = require('openvibe-sdk/service');
const { createPgTelemetrySink, startTelemetryRetention } = require('openvibe-sdk/telemetry');
const { createAuth } = require('./auth');
const { createMerchant } = require('./merchant');
const { createMerchantAuth } = require('./merchant-auth');
const { createApp } = require('./app');
const accountDataLib = require('./account-data');
const { createNetworkSender, startSubscriptions } = require('openvibe-sdk/account-data');

async function start({ config, db: givenDb = null, now = () => Date.now(), fetchImpl = globalThis.fetch, lookupImpl, merchantResolver = null, log = console, listen = true, limitsNow = null } = {}) {
    config = config || load();
    // PostgreSQL (ADR-035): opened and migrated here unless the caller (a test) hands in a migrated handle.
    const db = givenDb || await openDb(config, { log });
    const outbox = createServiceOutbox({
        db, source: config.serviceId, eventsUrl: config.events.url, networkInternalUrl: config.networkInternalUrl,
        clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        intervalMs: config.events.relayIntervalMs, log, table: 'service_outbox', eventTypes: manifest.eventsProduced,
        validate: (env) => validate('events.event-envelope@1', env), now, fetch: fetchImpl,
    });
    const emitEvent = (args) => {
        if (!db.inTransaction()) throw new Error('event emission must run inside the transaction that makes the change');
        return outbox.emit(createEnvelope(args, { source: config.serviceId, now }));
    };
    const registry = createRegistry({ db, now, maxItemsCap: config.items.maxPerFetch });
    const items = createItems({ db, emitEvent, now });
    const guard = createGuard({ allowPrivateHosts: config.fetch.allowPrivateHosts, allowedPorts: config.fetch.allowedPorts, ...(lookupImpl ? { lookupImpl } : {}) });
    const fetcher = createFetcher({ guard, userAgent: config.fetch.userAgent, timeoutMs: config.fetch.timeoutMs, maxBytes: config.fetch.maxBytes, maxRedirects: config.fetch.maxRedirects });
    const spacer = createSpacer({ hostMinIntervalMs: config.fetch.hostMinIntervalMs });
    const robots = createRobots({
        db, fetcher, agent: config.fetch.robotsAgent, ttlMs: config.fetch.robotsTtlMs, maxBytes: config.fetch.robotsMaxBytes, now,
        beforeRequest: (host) => spacer.space(host, 0),
    });
    const ingest = createIngest({ db, config, registry, items, robots, fetcher, spacer, emitEvent, now, log, outbox });
    const scheduler = createScheduler({ db, ingest, config, now, log });
    const keys = jwksClient(config.jwksUrl, { fetch: fetchImpl, log });
    const auth = createAuth({ config, log, jwks: keys });
    const merchant = createMerchant({ db, config, registry, fetcher, resolver: merchantResolver, now, log });
    const merchantAuth = createMerchantAuth({ config, auth, log, fetchImpl });
    const accountData = accountDataLib.create({ db, log });
    const accountSend = config.oauth.clientSecret ? createNetworkSender({ networkInternalUrl: config.networkInternalUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, fetch: fetchImpl }) : null;
    const app = createApp({ config, db, registry, items, ingest, scheduler, auth, outbox, now, log, limitsNow, merchant, merchantAuth, accountData, accountSend });
    // One JWKS client for the process (the SDK shares it with verifyUserToken): refresh in the background
    // on an unref'd timer, keeping the last good keys through a Network outage.
    keys.start();
    const keyLoaded = keys.keys().catch(() => null);
    outbox.start();
    if (config.worker.enabled) scheduler.start();
    // Pending merchant proofs are checked again on a slow cadence (the merchant can always press "Check now"). A claim
    // that never verifies fails after merchant.pendingDays. 0 turns the worker pass off (tests).
    let merchantTimer = null;
    let merchantKick = null;
    if (config.merchant.recheckIntervalMs > 0) {
        merchantTimer = setInterval(() => merchant.recheck().catch((err) => log.error(`[merchant] recheck: ${err.stack || err}`)), config.merchant.recheckIntervalMs);
        merchantTimer.unref?.();
        merchantKick = setTimeout(() => merchant.recheck().catch((err) => log.error(`[merchant] recheck: ${err.stack || err}`)), 5000);
        merchantKick.unref?.();
    }
    const pruneTimer = setInterval(async () => { try { await outbox.outbox.prune(); } catch (err) { log.error(`[outbox] prune: ${err.message}`); } }, 6 * 3600 * 1000);
    pruneTimer.unref?.();

    let server = null;
    let accountSubscription = null;
    if (listen) {
        server = await new Promise((resolve, reject) => {
            // Socket activation (2026-10-31): systemd's .socket unit holds the listener across restarts, so a deploy
            // queues requests in the kernel instead of answering 502. Without the socket unit, the usual listen.
            const socketActivated = process.env.LISTEN_FDS === '1' && Number(process.env.LISTEN_PID) === process.pid;
            const s = app.listen(...(socketActivated ? [{ fd: 3 }] : [config.port, config.host]), () => resolve(s));
            s.on('error', reject);
        });
        log.log(`[sources] listening on http://${config.host}:${server.address().port}`);
        if (config.events.secret.length >= 32 && config.events.url && config.oauth.clientSecret) {
            accountSubscription = startSubscriptions({
                eventsUrl: config.events.url, endpoint: `http://127.0.0.1:${config.callbackPort || config.port}/internal/events`, secret: config.events.secret,
                networkInternalUrl: config.networkInternalUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, fetch: fetchImpl, log,
            });
        }
    }

    async function close() {
        clearInterval(pruneTimer);
        if (merchantTimer) clearInterval(merchantTimer);
        if (merchantKick) clearTimeout(merchantKick);
        keys.stop();
        if (accountSubscription) accountSubscription.stop();
        await scheduler.stop();
        await outbox.stop();
        if (server) {
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(() => resolve()));
        }
        if (!givenDb) await db.close();
    }

    return { config, db, registry, items, guard, fetcher, robots, ingest, scheduler, outbox, keys, keyLoaded, auth, merchant, merchantAuth, app, server, close };
}

if (require.main === module) {
    require('dotenv').config();
    start().then((handles) => {
        // SIGTERM/SIGINT (openvibe-sdk/service, docs/service.md's handles family, Sources 20 s): requests in
        // flight get 15 s, then handles.close() (the prune timer and JWKS refresher stopped, the scheduler,
        // relay and server stopped, the database closed; a rejection exits 1); past 20 s the process exits 1.
        // Request telemetry (openvibe-sdk/service, plan T1): one aggregated sample per route template, method and status
        // class each minute, stored in this service's telemetry_samples table; rows older than 14 days go daily.
        telemetry.init({ service: 'sources', sink: createPgTelemetrySink({ db: handles.db, log: console }), skipPrefixes: ['/shared'], intervalMs: 60_000 });
        const telemetryRetention = startTelemetryRetention({ db: handles.db, log: console, olderThanDays: 14 });
        gracefulStop({ name: 'Sources', server: handles.server, handles, drainMs: 15000, deadlineMs: 20000, stop: [async () => { if (telemetryRetention) await telemetryRetention.stop(); await telemetry.stop(); }] });
    }).catch((err) => {
        console.error(`[sources] failed to start: ${err.stack || err}`);
        process.exit(1);
    });
}

module.exports = { start };
