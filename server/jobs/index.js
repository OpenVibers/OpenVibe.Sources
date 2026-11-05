'use strict';
/**
 * The repo's scheduled jobs, in one place: each is a small object with runOnce/start/stop, and this
 * helper arms them (the scheduler in server/scheduler.js is the ingestion worker, not a job). Today
 * there is one: item retention (server/jobs/retention.js). server/index.js starts it with the worker,
 * so tests and a worker-less process never run a prune behind a test's back.
 */
const { createRetentionJob } = require('./retention');

function createJobs({ db, now = () => Date.now(), log = console, retention: retentionOptions = {} } = {}) {
    const retention = createRetentionJob({ db, now, log, ...retentionOptions });
    const all = { retention };
    const running = new Map();
    let started = false;

    /** Run one job now; a second call while it runs shares it. → the job's counts. */
    function runOnce(name = 'retention') {
        const job = all[name];
        if (!job) return Promise.reject(new Error(`no job named ${name}`));
        if (running.has(name)) return running.get(name);
        const p = Promise.resolve().then(() => job.runOnce()).finally(() => running.delete(name));
        running.set(name, p);
        return p;
    }

    function start() {
        if (started) return false;
        started = true;
        for (const job of Object.values(all)) job.start();
        return true;
    }

    async function stop() {
        started = false;
        for (const job of Object.values(all)) await job.stop();
        await Promise.allSettled([...running.values()]);
    }

    return { retention, all, runOnce, start, stop, started: () => started, running: () => running.size };
}

module.exports = { createJobs };
