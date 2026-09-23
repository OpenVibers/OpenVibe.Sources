'use strict';
/**
 * In-process scheduler: every SOURCES_TICK_MS, start runs for enabled, fetched sources whose
 * next_due_at and not_before have passed, oldest first, up to SOURCES_MAX_CONCURRENT runs at a
 * time. ingest.run() itself refuses a second run of a source already in flight.
 */
function createScheduler({ db, ingest, config, now = () => Date.now(), log = console }) {
    const due = db.prepare(`SELECT key FROM sources WHERE enabled = 1 AND type != 'manual'
        AND next_due_at <= @now AND not_before <= @now ORDER BY next_due_at, key LIMIT @limit`);
    let timer = null;
    const running = new Set();

    function tick() {
        const free = config.worker.maxConcurrent - running.size;
        if (free <= 0) return [];
        const keys = due.all({ now: now(), limit: free + running.size }).map(r => r.key).filter(k => !running.has(k)).slice(0, free);
        for (const key of keys) {
            running.add(key);
            ingest.run(key, { trigger: 'schedule' })
                .catch(err => log.error(`[scheduler] ${key}: ${err.stack || err}`))
                .finally(() => running.delete(key));
        }
        return keys;
    }

    function start() {
        if (timer) return;
        timer = setInterval(() => { try { tick(); } catch (err) { log.error(`[scheduler] tick: ${err.message}`); } }, config.worker.tickMs);
        timer.unref?.();
    }

    async function stop() {
        if (timer) clearInterval(timer);
        timer = null;
        // let runs in flight finish (each is bounded by the fetch timeout)
        const deadline = Date.now() + 15000;
        while (running.size && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    }

    return { start, stop, tick, running: () => Boolean(timer), active: () => [...running] };
}

module.exports = { createScheduler };
