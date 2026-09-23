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
const { createOutbox, createRelay } = require('./events/outbox');
const { createKeyStore, createAuth } = require('./auth');
const { createApp } = require('./app');

async function start({ config, now = () => Date.now(), fetchImpl = globalThis.fetch, tokenClient, lookupImpl, log = console, listen = true } = {}) {
    config = config || load();
    const db = openDb(config.dbPath);
    const outbox = createOutbox(db, { source: config.serviceId, now });
    const relay = createRelay({
        db, outbox, eventsUrl: config.events.url, intervalMs: config.events.relayIntervalMs, fetchImpl, log, now,
        tokenClient,
        tokenOpts: config.oauth.clientSecret ? { tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret } : null,
    });
    const registry = createRegistry({ db, now, maxItemsCap: config.items.maxPerFetch });
    const items = createItems({ db, outbox, now });
    const guard = createGuard({ allowPrivateHosts: config.fetch.allowPrivateHosts, allowedPorts: config.fetch.allowedPorts, ...(lookupImpl ? { lookupImpl } : {}) });
    const fetcher = createFetcher({ guard, userAgent: config.fetch.userAgent, timeoutMs: config.fetch.timeoutMs, maxBytes: config.fetch.maxBytes, maxRedirects: config.fetch.maxRedirects });
    const spacer = createSpacer({ hostMinIntervalMs: config.fetch.hostMinIntervalMs });
    const robots = createRobots({
        db, fetcher, agent: config.fetch.robotsAgent, ttlMs: config.fetch.robotsTtlMs, maxBytes: config.fetch.robotsMaxBytes, now,
        beforeRequest: (host) => spacer.space(host, 0),
    });
    const ingest = createIngest({ db, config, registry, items, robots, fetcher, spacer, outbox, now, log, relay });
    const scheduler = createScheduler({ db, ingest, config, now, log });
    const keys = createKeyStore({ urls: [config.networkInternalUrl, config.networkUrl], pem: config.networkPublicKey, fetchImpl, log });
    const auth = createAuth({ config, keys });
    const app = createApp({ config, db, registry, items, ingest, scheduler, auth, keys, outbox, relay, now, log });

    const keyLoaded = keys.start().catch(() => null);
    relay.start();
    if (config.worker.enabled) scheduler.start();
    const pruneTimer = setInterval(() => { try { outbox.prune(); } catch (err) { log.error(`[outbox] prune: ${err.message}`); } }, 6 * 3600 * 1000);
    pruneTimer.unref?.();

    let server = null;
    if (listen) {
        server = await new Promise((resolve, reject) => {
            const s = app.listen(config.port, config.host, () => resolve(s));
            s.on('error', reject);
        });
        log.log(`[sources] listening on http://${config.host}:${server.address().port}`);
    }

    async function close() {
        clearInterval(pruneTimer);
        keys.stop();
        await scheduler.stop();
        await relay.stop();
        if (server) {
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(() => resolve()));
        }
        db.close();
    }

    return { config, db, registry, items, guard, fetcher, robots, ingest, scheduler, outbox, relay, keys, keyLoaded, auth, app, server, close };
}

if (require.main === module) {
    require('dotenv').config();
    start().then((handles) => {
        const shutdown = (sig) => {
            console.log(`[sources] ${sig}: shutting down`);
            handles.close().then(() => process.exit(0), () => process.exit(1));
            setTimeout(() => process.exit(1), 20000).unref();
        };
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
    }).catch((err) => {
        console.error(`[sources] failed to start: ${err.stack || err}`);
        process.exit(1);
    });
}

module.exports = { start };
