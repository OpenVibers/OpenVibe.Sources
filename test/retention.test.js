'use strict';
/**
 * Item retention (server/retention.js, server/jobs/): the category windows, the age of a removed item,
 * keep-latest per source key, batching and idempotence. A real migrated database (PGlite, or the
 * containers with SOURCES_TEST_STORE=pg), no network.
 *
 *   node test/retention.test.js
 */
const assert = require('assert');
const { testDb } = require('./db');
const { createRetention, RULES, DAY } = require('../server/retention');
const { createJobs } = require('../server/jobs');
const { CATEGORIES } = require('../server/registry');

const NOW = Date.parse('2026-11-05T12:00:00Z');
const silent = { log() {}, warn() {}, error() {} };
let db;
let seq = 0;

async function item({ id, category = 'news', source = 'src-a', identity = id, retrieved, removed = null, title = id }) {
    seq++;
    await db.query(`INSERT INTO items (id, source_key, category, identity, kind, title, content_hash, parser_version,
        first_seen_at, retrieved_at, removed_at, removed_reason, change_seq)
        VALUES ($1, $2, $3, $4, 'record', $5, 'hash', 'test@1', $6, $6, $7, $8, $9)`,
    [id, source, category, identity, title, retrieved, removed, removed ? 'test removal' : null, seq]);
    await db.query(`INSERT INTO item_revisions (item_id, revision, content_hash, parser_version, retrieved_at, snapshot)
        VALUES ($1, 1, 'hash', 'test@1', $2, '{}')`, [id, retrieved]);
}

const rows = async (where = '') => await db.query(`SELECT id, title, identity FROM items ${where} ORDER BY id`);
const ids = async (where = '') => (await rows(where)).rows.map((r) => r.id);
const revisions = async (id) => Number(await db.value('SELECT count(*) FROM item_revisions WHERE item_id = $1', [id]));

(async () => {
    const testdb = await testDb();
    db = testdb.db;
    try {
        // Every contract category has a rule, with a reason, in one of the two shapes.
        assert.deepStrictEqual([...CATEGORIES].sort(), Object.keys(RULES).sort(), 'one rule per source.v1 category');
        for (const [category, rule] of Object.entries(RULES)) {
            assert.strictEqual(typeof rule.reason, 'string');
            assert.ok(rule.reason.length > 10, `${category} says why`);
            assert.ok((Number.isInteger(rule.days) && rule.days >= 1) || rule.keepLatest === true, `${category} has a day window or keep-latest`);
            assert.ok(!(rule.days && rule.keepLatest), `${category} is one shape`);
        }
        assert.strictEqual(RULES.deals.days, 14);
        assert.strictEqual(RULES.news.days, 30);
        assert.strictEqual(RULES.housing.keepLatest, true);

        const logs = [];
        const retention = createRetention({ db, now: () => NOW, log: { log: (m) => logs.push(m), warn() {}, error() {} } });

        // A day window: older than the category's rule goes, newer stays; a removal is aged from
        // removed_at, not from retrieved_at, so a consumer gets the full window after the removal.
        await item({ id: 'news-old-live', retrieved: NOW - 31 * DAY });
        await item({ id: 'news-new-live', retrieved: NOW - 29 * DAY });
        await item({ id: 'news-old-removed-recently', retrieved: NOW - 100 * DAY, removed: NOW - 2 * DAY });
        await item({ id: 'news-removed-long-ago', retrieved: NOW - 3 * DAY, removed: NOW - 31 * DAY });
        await item({ id: 'deals-old', category: 'deals', retrieved: NOW - 15 * DAY });
        await item({ id: 'deals-new', category: 'deals', retrieved: NOW - 13 * DAY });

        const first = await retention.runOnce();
        assert.deepStrictEqual(await ids(), ['deals-new', 'news-new-live', 'news-old-removed-recently']);
        assert.deepStrictEqual(first.categories, { news: 2, deals: 1 });
        assert.strictEqual(first.pruned, 3);
        assert.strictEqual(first.revisions, 3);
        // Counts only: no item id, title or URL reaches the log.
        assert.match(logs[0], /^\[retention\] items: 3 pruned \(news 2, deals 1\), 3 revisions, \d+ batches$/);
        assert.ok(!logs[0].includes('news-old-live') && !logs[0].includes('deals-old'));
        assert.strictEqual(await revisions('news-old-live'), 0, 'a pruned item takes its revisions');
        assert.strictEqual(await revisions('news-new-live'), 1, 'a kept item keeps its revisions');
        assert.strictEqual(await revisions('news-old-removed-recently'), 1);

        // Idempotent: nothing left to prune, and the second run still checks every category.
        const second = await retention.runOnce();
        assert.strictEqual(second.pruned, 0);
        assert.strictEqual(second.revisions, 0);
        assert.deepStrictEqual(second.categories, {});
        assert.deepStrictEqual(await ids(), ['deals-new', 'news-new-live', 'news-old-removed-recently']);

        // Batched: small statements delete the backlog over several batches.
        for (let i = 0; i < 5; i++) await item({ id: `games-old-${i}`, category: 'games', retrieved: NOW - 15 * DAY });
        const batched = createRetention({ db, now: () => NOW, log: silent, batchSize: 2, maxBatches: 10 });
        const out = await batched.runOnce();
        assert.deepStrictEqual(await ids("WHERE id LIKE 'games-old-%'"), []);
        assert.deepStrictEqual(out.categories, { games: 5 });

        // A cap leaves the rest for the next daily run; the next runs finish it.
        for (let i = 0; i < 5; i++) await item({ id: `deals-capped-${i}`, category: 'deals', retrieved: NOW - 20 * DAY });
        const capped = createRetention({ db, now: () => NOW, log: silent, batchSize: 2, maxBatches: 1 });
        const c1 = await capped.runOnce();
        assert.deepStrictEqual(c1.categories, { deals: 2 });
        assert.deepStrictEqual(c1.capped, ['deals']);
        const c2 = await capped.runOnce();
        assert.deepStrictEqual(c2.categories, { deals: 2 });
        const c3 = await capped.runOnce();
        assert.deepStrictEqual(c3.categories, { deals: 1 });
        assert.deepStrictEqual(c3.capped, []);
        assert.deepStrictEqual(await ids("WHERE id LIKE 'deals-capped-%'"), []);

        // Keep-latest: one item per (source_key, identity), the newest. The items table already keeps
        // one row per key, so the test drops its unique constraint to prove what the rule does if a
        // source ever changes its identity format and leaves an older row for the same key.
        const unique = await db.value(`SELECT conname FROM pg_constraint
            WHERE conrelid = 'items'::regclass AND contype = 'u' AND pg_get_constraintdef(oid) LIKE 'UNIQUE (source_key, identity)'`);
        assert.ok(unique, 'the items unique key is there');
        await db.query(`ALTER TABLE items DROP CONSTRAINT "${unique}"`);
        await item({ id: 'rent-old', category: 'housing', source: 'hud-fair-market-rents', identity: 'METRO1', retrieved: NOW - 2 * DAY, title: 'old value' });
        await item({ id: 'rent-new', category: 'housing', source: 'hud-fair-market-rents', identity: 'METRO1', retrieved: NOW - 1 * DAY, title: 'new value' });
        await item({ id: 'rent-other', category: 'housing', source: 'hud-fair-market-rents', identity: 'METRO2', retrieved: NOW - 400 * DAY, title: 'other area' });
        const keep = await retention.runOnce();
        assert.deepStrictEqual(keep.categories, { housing: 1 });
        assert.deepStrictEqual(await ids("WHERE id LIKE 'rent-%'"), ['rent-new', 'rent-other']);
        assert.strictEqual((await rows("WHERE id = 'rent-new'")).rows[0].title, 'new value');

        // The repo's job helper arms the job, runs one on demand and stops it. (The real first run is
        // five minutes out, so a test boot never prunes behind a test's back.)
        const jobs = createJobs({ db, now: () => NOW, log: silent, retention: { firstMs: 3_600_000 } });
        assert.strictEqual(jobs.start(), true);
        assert.strictEqual(jobs.start(), false, 'starting twice is a no-op');
        const viaHelper = await jobs.runOnce('retention');
        assert.strictEqual(viaHelper.pruned, 0, 'the helper reaches the same prune');
        assert.strictEqual(jobs.running(), 0);
        await jobs.stop();
        await assert.rejects(jobs.runOnce('nope'), /no job named nope/);

        console.log('retention: all checks passed');
    } finally {
        await testdb.close();
    }
})().catch((err) => { console.error(err); process.exit(1); });
