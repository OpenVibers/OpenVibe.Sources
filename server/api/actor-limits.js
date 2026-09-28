'use strict';
/**
 * Per-actor rate limits on /api/v1 (roadmap WS-R task 4; openvibe-sdk/limits).
 *
 * Every API route takes a service token and one capability (auth.js); the limits count requests by
 * the principal that passed that guard (req.principal.sub: svc:news, app:app_…), before the route does
 * any work. Sources' own workers (the scheduler, fetches, the outbox relay) run in this process and
 * never go through HTTP, so nothing here can slow them.
 *
 *   Reads (sources.source.read, sources.item.read) take SOURCES_LIMITS_MINUTE / SOURCES_LIMITS_HOUR,
 *   120 and 3000, for an app or module (app:…, mod:…). A first-party service (svc:…) is not counted on
 *   reads: News, Reviews and Trade pull cursor pages for all their readers, and Wiki asks about every
 *   item its editors cite, so one budget for the whole service would refuse real people's work. The API
 *   answers only on the production host (nginx serves the public host nothing but health, ready and
 *   release.json).
 *
 *   Writes (sources.source.manage, staff tooling) are counted for every principal, each with its own
 *   budget below.
 *
 * Past a limit the route answers 429 problem+json `rate_limited` with Retry-After; the refusal is logged
 * once and counted in sources_rate_limited_total{limit,window}. Counters live in this process: a
 * restart forgets them. Never limited: /api/health, /api/ready, /release.json, /metrics and the home
 * page.
 */
const { createActorLimiter, defaultActor } = require('openvibe-sdk/limits');

const FIRST_PARTY = /^svc:/;

function actor(req) {
    const p = req.principal;
    if (p && typeof p.sub === 'string' && p.sub) return p.sub;
    return defaultActor(req);
}

/** Counted on reads: anything but a first-party service (an app or module acting as itself). */
function countedRead(req) {
    const p = req.principal;
    return !(p && FIRST_PARTY.test(String(p.sub)));
}

/** The writes, each with its numbers per principal (a minute, an hour). */
const BUDGETS = {
    // Creating, changing or deleting a source is a staff decision recorded with its terms and robots
    // notes: a form every few seconds at most.
    'sources.source.manage': { minute: 30, hour: 300 },
    // A manual fetch requests every endpoint of the source now (the per-host spacing still applies):
    // the scheduler already polls each source, so a person's "fetch now" is a rare nudge.
    'sources.source.fetch': { minute: 10, hour: 100 },
    // A manual item (a code or record a publisher stated, entered with its evidence URL) is stored,
    // revisioned and announced to subscribers: one a second.
    'sources.item.create': { minute: 60, hour: 1200 },
    // A removal (takedown, licence, error) hides the item everywhere and emits an event. A publisher's
    // takedown may cover many items, so two a second.
    'sources.item.remove': { minute: 120, hour: 3000 },
};

/**
 * limits(name, own) middleware, plus limits.reads(name) (the defaults on a counted read) and
 * limits.budget(name) (one of BUDGETS).
 */
function createActorLimits({ config, now = () => Date.now(), registry = null, log = console }) {
    const refused = registry
        ? registry.counter({ name: 'sources_rate_limited_total', help: 'Requests refused 429 by a per-actor limit, by limit name and window', labelNames: ['limit', 'window'] })
        : null;
    const limiter = createActorLimiter({
        limits: { minute: config.limits.minute, hour: config.limits.hour },
        actor,
        now,
        onLimited(e) {
            // The actor is a principal (or an address), never a token.
            log.warn(`[limits] ${e.name}: ${e.actor} refused, over ${e.limit} per ${e.window}`);
            if (refused) refused.inc({ limit: e.name, window: e.window });
        },
    });
    limiter.reads = (name) => {
        const limit = limiter(name);
        return function actorReadLimit(req, res, next) { return countedRead(req) ? limit(req, res, next) : next(); };
    };
    const budgets = new Map(Object.entries(BUDGETS).map(([name, own]) => [name, limiter(name, own)]));
    limiter.budget = (name) => {
        const m = budgets.get(name);
        if (!m) throw new Error(`limits: no budget named ${name}`);
        return m;
    };
    return limiter;
}

module.exports = { createActorLimits, actor, countedRead, BUDGETS };
