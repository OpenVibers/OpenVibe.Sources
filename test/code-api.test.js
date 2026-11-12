'use strict';
/**
 * /api/v1/code: the repository rankings and the live search. Ingestion is driven by a stubbed GitHub
 * client (no network); the history is written through the real run transaction, then older days are
 * inserted so "hot" is computed from stars gained, not from totals.
 */
const assert = require('assert');
const { boot, request, serviceToken, suite } = require('./helpers');
const github = require('../server/adapters/github');

const t = suite('code');
let svc;
const ITEMS = serviceToken('exchange', ['sources.item.read']);
const SOURCES = serviceToken('exchange', ['sources.source.read']);
const NOW = Date.now();
const DAY = 86400000;

function repo(full, { stars, language, created, topics = ['ai'] }) {
    return {
        full_name: full, html_url: `https://github.com/${full}`, description: `${full} description`,
        stargazers_count: stars, forks_count: 12, open_issues_count: 3, language, topics,
        license: { spdx_id: 'MIT', name: 'MIT License' }, created_at: created, pushed_at: new Date(NOW - 3600000).toISOString(),
        owner: { login: full.split('/')[0], avatar_url: `https://avatars.githubusercontent.com/u/1?v=4` },
        homepage: `https://${full.split('/')[0]}.example`, archived: false, fork: false,
    };
}

const A = repo('acme/hot', { stars: 500, language: 'Rust', created: new Date(NOW - 3600000).toISOString() });
const B = repo('beta/steady', { stars: 100, language: 'Python', created: new Date(NOW - 2 * DAY).toISOString(), topics: ['tools'] });

t('boot and one GitHub run', async () => {
    svc = await boot();
    const seed = require('../seeds/sources.json').sources.find((s) => s.key === 'github');
    await svc.registry.create(seed, 'test');
    await svc.db.prepare("UPDATE sources SET enabled = 1, min_interval_ms = 0, last_request_at = NULL WHERE key = 'github'").run();
    svc.ingest.github.hasToken = () => false;
    svc.ingest.github.fetchQueries = async () => ({
        items: [github.repoItem(A, 1000), github.repoItem(B, 1000)],
        stars: [{ full_name: 'acme/hot', stars: 500 }, { full_name: 'beta/steady', stars: 100 }],
        next: 2, queries: 2, lastStatus: 200, bytes: 100, rawBodyHash: 'a'.repeat(64), notBefore: 0, limited: false,
    });
    const out = await svc.ingest.run('github');
    assert.strictEqual(out.runs[0].state, 'ok');
    assert.strictEqual(out.runs[0].items_created, 2);
    const stars = await svc.db.prepare('SELECT full_name, day, stars FROM github_stars ORDER BY full_name').all();
    assert.deepStrictEqual(stars.map((s) => [s.full_name, s.stars]), [['acme/hot', 500], ['beta/steady', 100]]);
    // Older days complete the history: +100/+5 in 1 day and +200/+10 in 7.
    const put = svc.db.prepare('INSERT INTO github_stars (source_key, full_name, day, stars, captured_at) VALUES (?, ?, ?, ?, ?)');
    await put.run('github', 'acme/hot', github.isoDay(NOW - DAY), 400, NOW - DAY);
    await put.run('github', 'acme/hot', github.isoDay(NOW - 7 * DAY), 300, NOW - 7 * DAY);
    await put.run('github', 'beta/steady', github.isoDay(NOW - DAY), 95, NOW - DAY);
    await put.run('github', 'beta/steady', github.isoDay(NOW - 7 * DAY), 90, NOW - 7 * DAY);
});

t('the rankings need sources.item.read, carry the public item shape and rank hot by stars gained', async () => {
    assert.strictEqual((await request(svc.base, 'GET', '/api/v1/code/repos')).status, 401);
    assert.strictEqual((await request(svc.base, 'GET', '/api/v1/code/repos', { token: SOURCES })).status, 403);
    const week = await request(svc.base, 'GET', '/api/v1/code/repos?list=week&limit=10', { token: ITEMS });
    assert.strictEqual(week.status, 200);
    assert.strictEqual(week.body.list, 'week');
    assert.strictEqual(week.body.items.length, 2);
    const one = week.body.items.find((x) => x.full_name === 'acme/hot');
    for (const key of ['full_name', 'url', 'description', 'language', 'topics', 'stars', 'stars_gained_1d', 'stars_gained_7d', 'forks', 'open_issues', 'license', 'created', 'pushed', 'owner_avatar_url', 'homepage']) assert.ok(key in one, key);
    assert.strictEqual(one.stars, 500);
    assert.strictEqual(one.stars_gained_1d, 100);
    assert.strictEqual(one.stars_gained_7d, 200);
    assert.strictEqual(one.license, 'MIT');
    const hot = await request(svc.base, 'GET', '/api/v1/code/repos?list=hot', { token: ITEMS });
    assert.deepStrictEqual(hot.body.items.map((x) => x.full_name), ['acme/hot', 'beta/steady']);
    assert.deepStrictEqual([hot.body.items[0].stars_gained_1d, hot.body.items[0].stars_gained_7d], [100, 200]);
    const rust = await request(svc.base, 'GET', '/api/v1/code/repos?list=month&lang=Rust', { token: ITEMS });
    assert.deepStrictEqual(rust.body.items.map((x) => x.full_name), ['acme/hot']);
    const tools = await request(svc.base, 'GET', '/api/v1/code/repos?list=top&topic=tools', { token: ITEMS });
    assert.deepStrictEqual(tools.body.items.map((x) => x.full_name), ['beta/steady']);
    assert.strictEqual((await request(svc.base, 'GET', '/api/v1/code/repos?list=weather', { token: ITEMS })).status, 422);
});

t('the live search passes q and language through, fills the gains, and answers 429 with Retry-After', async () => {
    const seen = [];
    svc.ingest.github.search = async (args) => {
        seen.push(args);
        return { items: [github.publicRepository(github.repoItem(A, 1000))], total: 1, incomplete: false, page: 1, sort: 'stars', q: args.q, lang: args.lang, cached: false, stale: false };
    };
    const r = await request(svc.base, 'GET', '/api/v1/code/search?q=stars:>500%20topic:ai&lang=Rust&sort=stars&page=1', { token: ITEMS });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(seen[0], { q: 'stars:>500 topic:ai', lang: 'Rust', sort: 'stars', page: 1 });
    assert.strictEqual(r.body.items[0].full_name, 'acme/hot');
    assert.strictEqual(r.body.items[0].stars_gained_1d, 100);
    assert.match(r.headers.get('cache-control'), /max-age=600/);
    assert.strictEqual((await request(svc.base, 'GET', '/api/v1/code/search?q=', { token: ITEMS })).status, 422);
    svc.ingest.github.search = async () => { throw Object.assign(new Error('slow down'), { code: 'rate_limited', retryAfterMs: 30000 }); };
    const limited = await request(svc.base, 'GET', '/api/v1/code/search?q=ai', { token: ITEMS });
    assert.strictEqual(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 30);
    assert.strictEqual(limited.body.code, 'sources.rate_limited');
});

t('stop', async () => { await svc.stop(); });

t.run();
