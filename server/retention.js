'use strict';
/**
 * Item retention: the one place that says how long Sources keeps an item of each category, and the
 * batched prune the daily job runs (server/jobs/retention.js).
 *
 * The age of an item is the last time it was current: `retrieved_at` while it is live, `removed_at`
 * once it was removed (a removal is a change consumers following the change feed may still need;
 * keeping it for the category's window after the removal, not after the last fetch, is what lets a
 * consumer that was down catch up). `first_seen_at` is not the age: a source that keeps listing a
 * job or a price keeps that item current, however old the record is.
 *
 * Two rule shapes:
 *   - `days`: prune items whose age is older than that many days.
 *   - `keepLatest`: keep the newest item per (source_key, identity), the source's own key for the
 *     record, and prune an older row for that key. Yearly values (HUD's Fair Market Rents, one
 *     current value per area, fetched weekly and replaced each October) must never age out: the
 *     latest value is the one Rent shows, so there is no day window for the category. The items
 *     table already keeps one row per (source_key, identity); the rule is what keeps a future
 *     identity change from leaving two rows for the same source key, and it documents that the
 *     category is not age-pruned.
 *
 * Why each window (each consumer was read before choosing it; all of them copy what they show):
 *   - news 30 days: News shows the last 30 days and follows the change feed into its own table.
 *   - blog 90 days: the weekly desks read a week of items; a quarter covers a failed pull.
 *   - reviews 180 days: reviews and official records are kept by Reviews; half a year covers an
 *     import rebuild without holding the raw stream forever.
 *   - deals 14 days: offers are short-lived (DealNews' daily feed, shops' hourly crawls) and Deals
 *     keeps the offers it shows.
 *   - coupons 90 days: a code's stated expiry can be months out; Coupons needs its evidence until
 *     then.
 *   - trade 365 days: filings and market observations are annual records Trade copies and cites.
 *   - hosting 30 days: prices are current; Host copies the catalog and polls at least weekly, so a
 *     month survives two missed polls.
 *   - crowdfunding 90 days: campaigns run for weeks or months and Deals copies the ones it lists.
 *   - games 14 days: top sellers, new releases and specials are current lists, polled every three
 *     hours; Games copies them.
 *   - housing keepLatest: HUD Fair Market Rents and Small Area FMRs are yearly; one current value
 *     per area must stay. BLS' monthly rent series lives on its own identities, so a duplicate-key
 *     prune never touches a month.
 *   - food 365 days: Food keeps the FDA recall history it shows (and BLS prices); Sources keeps a
 *     year for a rebuild and the Open Food Facts bulk snapshot, which is regenerated.
 *   - jobs 14 days: Arbeitnow and We Work Remotely retire what the board stopped showing after 7
 *     days; Work copies each listing, so a fortnight keeps every tombstone it may pull.
 *   - code 30 days: the GitHub rankings are a current list; a month keeps a repository through a failed
 *     pull, and the star history is what says whether it is still hot.
 *
 * Sources has no openvibe-shared/config namespace, so the rules stay in code (the brief's
 * alternative); a day count this consequential should change in review, not in a database row.
 *
 * A contract pin can add a category before this table learns its window. That must not crash the
 * service at boot: at runtime an unruled category is kept (never pruned), and a rule for a category
 * the contract no longer has is ignored, each with one warning line per run. The strict one-to-one
 * check lives in test/retention.test.js instead, so the pin bump PR fails CI and names the rule to
 * add while production keeps serving in the meantime.
 */
const CATEGORY_CONTRACT = require('openvibe-contracts/contracts/sources/category.v1.json');
/** The categories `sources.category@1` names: the contract this table implements. */
const CATEGORY_KEYS = Object.freeze([...CATEGORY_CONTRACT.properties.key.enum]);

const DAY = 86_400_000;
/** Rows per DELETE; a few thousand is fast on PostgreSQL and stays well under the parameter limit. */
const BATCH_SIZE = 2_000;
/** Batches per category per run: 100,000 rows. A larger backlog continues on the next daily run. */
const MAX_BATCHES = 50;

const RULES = Object.freeze({
    news: { days: 30, reason: 'News shows the last 30 days and copies every item it follows' },
    blog: { days: 90, reason: 'weekly desks read a week; a quarter covers a failed pull' },
    reviews: { days: 180, reason: 'Reviews keeps what it shows; half a year covers an import rebuild' },
    deals: { days: 14, reason: 'offers are short-lived and Deals copies them' },
    coupons: { days: 90, reason: 'a code\'s stated expiry can be months out and Coupons needs its evidence' },
    trade: { days: 365, reason: 'SEC filings and observations are annual records Trade copies' },
    hosting: { days: 30, reason: 'prices are current, Host copies them, two weekly polls fit in a month' },
    crowdfunding: { days: 90, reason: 'campaigns run for months and Deals copies the ones it lists' },
    games: { days: 14, reason: 'featured lists are current and polled every three hours; Games copies them' },
    housing: { keepLatest: true, reason: 'HUD rents change yearly: the latest value per area is what Rent shows' },
    food: { days: 365, reason: 'Food keeps the recall history it shows; a year covers a rebuild' },
    jobs: { days: 14, reason: 'boards retire unseen jobs after 7 days and Work pulls hourly' },
    code: { days: 30, reason: 'GitHub rankings are current; a month keeps the tracked set through a failed pull' },
});

// The rules are the contract's categories in review; the runtime deliberately does not throw when
// they disagree (a pin bump must not stop Sources at boot; test/retention.test.js is strict).

/** The age expression shared by the prune statements: last current, not first seen. */
const AGE_SQL = 'CASE WHEN removed_at IS NULL THEN retrieved_at ELSE removed_at END';
/** The same age as a predicate the two partial indexes (migration 0010) can serve: live rows by
 *  retrieved_at, removed rows by removed_at. */
const OLDER_THAN_SQL = '((removed_at IS NULL AND retrieved_at < $2) OR (removed_at IS NOT NULL AND removed_at < $2))';

function createRetention({ db, rules = RULES, now = () => Date.now(), log = console, batchSize = BATCH_SIZE, maxBatches = MAX_BATCHES } = {}) {
    if (!db || typeof db.prepare !== 'function' || typeof db.tx !== 'function') throw new TypeError('retention: an openvibe-sdk/db handle is required');
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) throw new TypeError('retention: batchSize must be an integer between 1 and 10000');
    if (!Number.isInteger(maxBatches) || maxBatches < 1) throw new TypeError('retention: maxBatches must be a positive integer');

    // One statement/batch: delete the rows, then the revisions that belonged to them (no foreign
    // key keeps them, and a revision of a pruned item would otherwise grow forever).
    async function pruneBatch(selectSql, params) {
        return await db.tx(async (t) => {
            const rows = await t.query(`DELETE FROM items WHERE rid IN (${selectSql}) RETURNING id`, params);
            const ids = rows.rows.map((r) => r.id);
            let revisions = 0;
            if (ids.length) revisions = (await t.query('DELETE FROM item_revisions WHERE item_id = ANY($1)', [ids])).rowCount;
            return { items: ids.length, revisions };
        });
    }

    async function pruneCategory(category, rule, cutoff, counts) {
        const select = rule.keepLatest
            ? { sql: `SELECT rid FROM (
                    SELECT rid, row_number() OVER (PARTITION BY source_key, identity ORDER BY retrieved_at DESC, rid DESC) AS rn
                    FROM items WHERE category = $1
                ) ranked WHERE rn > 1 ORDER BY rid LIMIT $2`, params: (limit) => [category, limit] }
            : { sql: `SELECT rid FROM items WHERE category = $1 AND ${OLDER_THAN_SQL} ORDER BY rid LIMIT $3`, params: (limit) => [category, cutoff, limit] };
        for (let batch = 0; batch < maxBatches; batch++) {
            const out = await pruneBatch(select.sql, select.params(batchSize));
            counts.batches++;
            counts.pruned += out.items;
            counts.revisions += out.revisions;
            if (out.items) counts.categories[category] = (counts.categories[category] || 0) + out.items;
            if (out.items < batchSize) return false;
        }
        return true;   // a full run of batches: more may be left for the next daily run
    }

    async function runOnce() {
        const at = now();
        const counts = { pruned: 0, revisions: 0, batches: 0, categories: {}, capped: [] };
        // A pin bump may reach production before this table does: keep an unruled category, ignore a
        // rule the contract no longer has, and say so once per run. The strict check is in the test.
        const known = new Set(CATEGORY_KEYS);
        for (const category of CATEGORY_KEYS) {
            if (!rules[category]) log.warn(`[retention] no rule for category ${category}: items kept`);
        }
        for (const category of Object.keys(rules)) {
            if (!known.has(category)) log.warn(`[retention] rule for ${category} ignored: not a sources.category@1 category`);
        }
        for (const [category, rule] of Object.entries(rules)) {
            if (!known.has(category)) continue;
            const cutoff = rule.days ? at - rule.days * DAY : null;
            if (await pruneCategory(category, rule, cutoff, counts)) counts.capped.push(category);
        }
        const perCategory = Object.entries(counts.categories).map(([c, n]) => `${c} ${n}`).join(', ');
        log.log(`[retention] items: ${counts.pruned} pruned${perCategory ? ` (${perCategory})` : ''}, ${counts.revisions} revisions, ${counts.batches} batches`
            + `${counts.capped.length ? `, more: ${counts.capped.join(', ')}` : ''}`);
        return counts;
    }

    let running = null;
    /** One prune at a time; concurrent callers share the run. */
    function run() {
        if (!running) running = runOnce().finally(() => { running = null; });
        return running;
    }

    return { run, runOnce, rules };
}

module.exports = { createRetention, RULES, CATEGORY_KEYS, AGE_SQL, OLDER_THAN_SQL, BATCH_SIZE, MAX_BATCHES, DAY };
