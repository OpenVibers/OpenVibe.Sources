'use strict';
/**
 * GitHub: the query plan, the recorded search answer mapped to items, the star-gain arithmetic from daily
 * snapshots, and the client's cursor, cache and rate-limit behaviour. The fetcher is a stub returning a
 * recorded api.github.com answer, so nothing here touches the network.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { suite } = require('./helpers');
const github = require('../server/adapters/github');
const { createGithub } = require('../server/github');

const t = suite('github');
const RECORDED = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'github', 'search-top.json'), 'utf8'));
const CONFIG = {
    fetch: { userAgent: 'OpenVibeBot/test' },
    items: { summaryMax: 1000 },
    secrets: {},
};
const silent = { log() {}, warn() {}, error() {} };
const allowedRobots = { check: async () => ({ allowed: true, reason: null, crawlDelaySec: 0 }) };
const noSpace = { space: async () => {}, setCrawlDelay() {} };

function fakeFetcher(handler) {
    return { fetchUrl: async (url, opts) => handler(url, opts) };
}

t('the plan is today, this week, this month, recently pushed, all-time top, new, and twelve languages', () => {
    const plan = github.plan(Date.parse('2026-11-12T12:00:00Z'));
    assert.deepStrictEqual(plan.slice(0, 6).map((q) => q.key), ['trending', 'week', 'month', 'pushed', 'top', 'new']);
    assert.strictEqual(plan[0].q, 'created:>2026-11-11');
    assert.strictEqual(plan[1].q, 'created:>2026-11-05');
    assert.strictEqual(plan[2].q, 'created:>2026-10-13');
    assert.strictEqual(plan[3].q, 'pushed:>2026-10-13 stars:>100');
    assert.strictEqual(plan.length, 6 + 12);
    assert.deepStrictEqual(github.LANGUAGES.slice(0, 3), ['JavaScript', 'TypeScript', 'Python']);
    assert.ok(plan.some((q) => q.q.includes('language:"Rust"')));
});

t('a recorded search answer becomes items with every stated field and null for the ones GitHub left out', () => {
    const items = RECORDED.items.map((r) => github.repoItem(r, 1000)).filter(Boolean);
    assert.strictEqual(items.length, 2);
    const first = items[0];
    assert.strictEqual(first.identity, 'codecrafters-io/build-your-own-x');
    assert.strictEqual(first.canonical_url, 'https://github.com/codecrafters-io/build-your-own-x');
    assert.strictEqual(first.fields.stars, 561961);
    assert.strictEqual(first.fields.language, 'Markdown');
    assert.ok(first.fields.owner_avatar_url.startsWith('https://avatars.githubusercontent.com/'));
    assert.ok(Array.isArray(first.fields.topics));
    assert.strictEqual(first.fields.license, null, 'no licence stated is null, never guessed');
    assert.strictEqual(first.fields.created, new Date(RECORDED.items[0].created_at).toISOString());
    const second = items[1];
    assert.ok(second.fields.license, 'a stated licence is kept');
    assert.ok(second.fields.homepage === null || second.fields.homepage.startsWith('https://'));
    const pub = github.publicRepository(first, { days_1: 12, days_7: null });
    assert.strictEqual(pub.stars_gained_1d, 12);
    assert.strictEqual(pub.stars_gained_7d, null);
    assert.strictEqual(pub.source, 'github');
});

t('a body without an items array is a parse error, never an empty success', () => {
    assert.throws(() => github.parseSearch({ total_count: 0 }), /items array/);
    assert.throws(() => github.parseSearch(null), /items array/);
});

t('stars gained come from daily snapshots; a window with no snapshot is null, never zero', () => {
    const now = Date.parse('2026-11-12T12:00:00Z');
    const history = [
        { day: '2026-11-04', stars: 100 },
        { day: '2026-11-10', stars: 180 },
        { day: '2026-11-11', stars: 195 },
        { day: '2026-11-12', stars: 210 },
    ];
    const g = github.gainsFrom(history, now);
    assert.deepStrictEqual([g.stars, g.days_1, g.days_7], [210, 15, 110]);
    const young = github.gainsFrom([{ day: '2026-11-12', stars: 14 }], now);
    assert.deepStrictEqual([young.stars, young.days_1, young.days_7], [14, null, null]);
    assert.deepStrictEqual(github.gainsFrom([], now), { stars: null, days_1: null, days_7: null });
});

t('one run asks its budget of queries from the stored cursor, keeps the stars and returns the next cursor', async () => {
    const seen = [];
    const client = createGithub({
        config: CONFIG, robots: allowedRobots, spacer: noSpace, now: () => Date.parse('2026-11-12T12:00:00Z'), log: silent,
        fetcher: fakeFetcher(async (url) => {
            seen.push(url);
            return { status: 200, body: Buffer.from(JSON.stringify(RECORDED)), headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '9', 'x-ratelimit-reset': '1794471413' }, bytes: 100, finalUrl: url };
        }),
    });
    const out = await client.fetchQueries({ source: { key: 'github', min_interval_ms: 0 }, cursor: {}, budget: 2 });
    assert.strictEqual(seen.length, 2);
    assert.match(seen[0], /created%3A%3E2026-11-12|created%3A%3E2026/);
    assert.strictEqual(out.queries, 2);
    assert.strictEqual(out.items.length, 2);
    assert.deepStrictEqual(out.stars.map((s) => s.full_name).sort(), ['codecrafters-io/build-your-own-x', 'sindresorhus/awesome']);
    assert.strictEqual(out.next, 2);
    const next = await client.fetchQueries({ source: { key: 'github', min_interval_ms: 0 }, cursor: { next: out.next }, budget: 1 });
    assert.strictEqual(next.queries, 1);
    assert.strictEqual(next.next, 3);
});

t('a rate-limited answer backs off: the reset time is honoured and a partial batch keeps what it has', async () => {
    let calls = 0;
    const reset = Math.floor(Date.parse('2026-11-12T12:01:00Z') / 1000);
    const client = createGithub({
        config: CONFIG, robots: allowedRobots, spacer: noSpace, now: () => Date.parse('2026-11-12T12:00:00Z'), log: silent,
        fetcher: fakeFetcher(async (url) => {
            calls++;
            if (calls === 1) return { status: 200, body: Buffer.from(JSON.stringify(RECORDED)), headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '1', 'x-ratelimit-reset': String(reset) }, bytes: 100, finalUrl: url };
            return { status: 403, body: Buffer.from('{"message":"API rate limit exceeded"}'), headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }, bytes: 40, finalUrl: url };
        }),
    });
    const out = await client.fetchQueries({ source: { key: 'github', min_interval_ms: 0 }, budget: 3 });
    assert.strictEqual(out.queries, 1, 'the batch stopped at the refusal');
    assert.strictEqual(out.limited, true);
    assert.strictEqual(out.items.length, 2);
    assert.ok(out.notBefore >= Date.parse('2026-11-12T12:00:59Z'), 'the next run waits for GitHub reset');
    assert.ok(!JSON.stringify(out).includes('Authorization'), 'the token never reaches a result');
});

t('a live search is cached for ten minutes and passes GitHub syntax through unchanged', async () => {
    let calls = 0;
    let seenUrl = '';
    const client = createGithub({
        config: CONFIG, robots: allowedRobots, spacer: noSpace, now: () => Date.parse('2026-11-12T12:00:00Z'), log: silent,
        fetcher: fakeFetcher(async (url) => {
            calls++;
            seenUrl = url;
            assert.match(decodeURIComponent(url).replace(/\+/g, ' '), /stars:>500 topic:ai language:"Rust"/);
            return { status: 200, body: Buffer.from(JSON.stringify(RECORDED)), headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '8', 'x-ratelimit-reset': '1794471413' }, bytes: 100, finalUrl: url };
        }),
    });
    const first = await client.search({ q: 'stars:>500 topic:ai', lang: 'Rust', sort: 'stars' });
    const second = await client.search({ q: 'stars:>500 topic:ai', lang: 'Rust', sort: 'stars' });
    assert.strictEqual(calls, 1, 'the second read is the cache');
    assert.strictEqual(second.cached, true);
    assert.strictEqual(first.items.length, 2);
    assert.strictEqual(first.page, 1);
    assert.match(decodeURIComponent(seenUrl), /sort=stars/);
});

t.run();
