'use strict';
/**
 * Item retention (server/retention.js, server/jobs/): the category windows as sources.category@1
 * documents, the age of a removed item, keep-latest per source key, batching, idempotence, and the
 * runtime grace for a category a pin bump added before the rule table did. A real migrated database
 * (PGlite, or the containers with SOURCES_TEST_STORE=pg), no network.
 *
 *   node test/retention.test.js
 */
const assert = require('assert');
const { createDb } = require('openvibe-sdk/db');
const { testDb } = require('./db');
const { validate } = require('openvibe-contracts');
const { createRetention, RULES, CATEGORY_KEYS, DAY } = require('../server/retention');
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
    // With SOURCES_TEST_STORE=pg the handle is the DML-only runtime role; DDL (the keep-latest test
    // drops a unique constraint) has to go through the owner connection, as migrations do.
    const owner = testdb.directUrl ? createDb({ url: testdb.directUrl, service: 'retention-test-owner', max: 1, log: silent }) : null;
    try {
        // STRICT BY DESIGN, TEST-ONLY: a Contracts pin that adds a category must fail here, on the
        // bump PR, naming the missing rule. server/retention.js itself keeps + warns at runtime.
        assert.deepStrictEqual([...CATEGORIES].sort(), [...CATEGORY_KEYS].sort(), 'sources.source@1 and sources.category@1 name the same categories');
        assert.deepStrictEqual([...CATEGORY_KEYS].sort(), Object.keys(RULES).sort(), 'one rule per sources.category@1 key');
        for (const [category, rule] of Object.entries(RULES)) {
            assert.strictEqual(typeof rule.reason, 'string');
            assert.ok(rule.reason.length > 10, `${category} says why`);
            assert.ok((Number.isInteger(rule.days) && rule.days >= 1) || rule.keepLatest === true, `${category} has a day window or keep-latest`);
            assert.ok(!(rule.days && rule.keepLatest), `${category} is one shape`);
            // The rule is the contract's document for its category, so a field the schema does not
            // have (or a window outside 1..3650 days) fails here rather than in production.
            const document = { key: category, retention: rule.keepLatest ? 'keep' : { days: rule.days, reason: rule.reason } };
            const result = validate('sources.category@1', document);
            assert.ok(result.valid, `${category} is a sources.category@1 document: ${JSON.stringify(result.errors)}`);
        }
        assert.strictEqual(validate('sources.category@1', { key: 'news', retention: { days: 0 } }).valid, false, 'a zero-day window is refused by sources.category@1');
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

        // Runtime grace: a category the contract has but the rules do not is kept (never pruned),
        // and an extra rule is ignored, each with one warning line per run. The strict check above is
        // what makes the pin bump fail in CI; this is what keeps production serving meanwhile.
        await item({ id: 'news-unruled', retrieved: NOW - 100 * DAY });
        await item({ id: 'deals-injected', category: 'deals', retrieved: NOW - 20 * DAY });
        const injectedRules = { ...RULES, weather: { days: 1, reason: 'test-only category the contract lacks' } };
        delete injectedRules.news;
        const injectedLogs = [];
        const injected = createRetention({
            db, rules: injectedRules, now: () => NOW,
            log: { log: (m) => injectedLogs.push(m), warn: (m) => injectedLogs.push(m), error() {} },
        });
        const injectedOut = await injected.runOnce();
        assert.deepStrictEqual(injectedOut.categories, { deals: 1 });
        assert.deepStrictEqual(await ids("WHERE id IN ('news-unruled', 'deals-injected')"), ['news-unruled'], 'unruled news kept');
        assert.strictEqual(injectedLogs.filter((m) => m === '[retention] no rule for category news: items kept').length, 1);
        assert.strictEqual(injectedLogs.filter((m) => m === '[retention] rule for weather ignored: not a sources.category@1 category').length, 1);
        await injected.runOnce();
        assert.strictEqual(injectedLogs.filter((m) => m === '[retention] no rule for category news: items kept').length, 2, 'one warning per run');
        assert.deepStrictEqual(await ids("WHERE id = 'news-unruled'"), ['news-unruled']);
        await db.query("DELETE FROM item_revisions WHERE item_id = 'news-unruled'");
        await db.query("DELETE FROM items WHERE id = 'news-unruled'");

        // Keep-latest: one item per (source_key, identity), the newest. The items table already keeps
        // one row per key, so the test drops its unique constraint to prove what the rule does if a
        // source ever changes its identity format and leaves an older row for the same key.
        const unique = await db.value(`SELECT conname FROM pg_constraint
            WHERE conrelid = 'items'::regclass AND contype = 'u' AND pg_get_constraintdef(oid) LIKE 'UNIQUE (source_key, identity)'`);
        assert.ok(unique, 'the items unique key is there');
        await (owner || db).query(`ALTER TABLE items DROP CONSTRAINT "${unique}"`);
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
        if (owner) await owner.close().catch(() => {});
        await testdb.close();
    }
})().catch((err) => { console.error(err); process.exit(1); });
