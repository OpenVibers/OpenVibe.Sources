'use strict';
/**
 * The daily item-retention job (server/retention.js for the rules and the prune itself).
 *
 * The first run is five minutes after boot, not a day out, so a service redeployed more often than
 * once a day still prunes; later runs are every 24 hours. Timers are unref'd, runs never overlap, and
 * a failed run is logged and retried at the next tick. The job logs counts only.
 */
const { createRetention } = require('../retention');

const FIRST_MS = 5 * 60_000;
const EVERY_MS = 24 * 3600 * 1000;

function createRetentionJob({ db, now = () => Date.now(), log = console, firstMs = FIRST_MS, everyMs = EVERY_MS } = {}) {
    const retention = createRetention({ db, now, log });
    let first = null;
    let every = null;
    let running = null;

    function runOnce() {
        if (!running) running = retention.run().finally(() => { running = null; });
        return running;
    }

    function start() {
        if (first || every) return false;
        first = setTimeout(() => { runOnce().catch((err) => log.error(`[retention] ${err.stack || err}`)); }, firstMs);
        every = setInterval(() => { runOnce().catch((err) => log.error(`[retention] ${err.stack || err}`)); }, everyMs);
        first.unref?.();
        every.unref?.();
        return true;
    }

    async function stop() {
        if (first) clearTimeout(first);
        if (every) clearInterval(every);
        first = null;
        every = null;
        if (running) await running.catch(() => {});
    }

    return { name: 'retention', runOnce, run: runOnce, start, stop, running: () => Boolean(running), retention };
}

module.exports = { createRetentionJob, FIRST_MS, EVERY_MS };
