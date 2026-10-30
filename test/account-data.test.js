'use strict';
/**
 * ADR-033: Sources' part of an account export and deletion. Sources holds no person's rows (a source is keyed by its
 * host, an item by its URL), so the part is empty and a deletion confirms nothing erased; the one exception is the
 * merchant opt-in, which is the merchant's own claim and goes with their account. The guard still runs, so a later
 * table with a person column fails here until it is answered for.
 */
const assert = require('assert');
const { uncovered } = require('openvibe-sdk/account-data');
const { testDb } = require('./db');
const { TABLES, create } = require('../server/account-data');

const A = 'usr_01JZ0000000000000000000AAA';
const B = 'usr_01JZ0000000000000000000BBB';

(async () => {
    const d = await testDb();
    try {
        const accountData = create({ db: d.db });
        await accountData.ensureSchema();
        const missing = await uncovered(d.db, {
            tables: [...TABLES, 'merchant_sources'], // the merchant's claim: exported and erased by this module
            exempt: { account_data_events: 'the ledger of requests itself: which export and deletion Sources applied' },
        });
        assert.deepStrictEqual(missing, [], `a table with a person column is neither covered nor exempted: ${missing.join(', ')}`);

        const part = await accountData.exportPart(A);
        assert.deepStrictEqual(part.files, [], 'Sources has no person rows to export');
        const counts = await accountData.erase([A]);
        assert.deepStrictEqual(counts, { erased: {}, retained: {} }, 'Sources has no person rows to erase');

        // The merchant opt-in: their claim, with the challenge they proved and the note that names them.
        for (const [subject, name] of [[A, 'ada'], [B, 'bo']]) {
            await d.db.exec(`INSERT INTO merchant_sources (id, owner_sub, owner_name, store_name, domain, method, token, listing_url, listing_kind, status, source_key, terms_note, created_at, updated_at)
                VALUES ($1, $2, $3, 'a store', $4, 'dns', 'challenge', 'https://example.test/sitemap.xml', 'sitemap', 'verified', $5, $6, 1, 1)`,
                [`msrc_${name}`, subject, name, `${name}.example.test`, `merchant-${name}-${name}`, `Merchant opt-in: ${subject} (${name}) gave OpenVibe explicit permission`]);
        }
        await d.db.exec("INSERT INTO sources (key, name, type, category, endpoints, terms_note, min_interval_ms, poll_interval_sec, stale_after_sec, max_items, enabled, review_required, sensitivity, default_indexability, created_at, updated_at) VALUES ('merchant-ada-ada', 'a store', 'sitemap', 'deals', '[]', 'Merchant opt-in: usr_01JZ0000000000000000000AAA (ada) gave OpenVibe explicit permission', 60, 900, 86400, 100, 1, 0, 'none', 'noindex', 1, 1)");

        const withClaim = await accountData.exportPart(A);
        const file = withClaim.files.find((f) => f.name === 'merchant-sources.json');
        assert.ok(file, 'the merchant claim is in the part');
        assert.strictEqual(file.content.length, 1);
        assert.strictEqual(file.content[0].id, 'msrc_ada');
        assert.ok(!JSON.stringify(withClaim).includes('challenge'), 'the challenge is never exported');
        assert.ok(!JSON.stringify(withClaim).includes(B), 'nobody else\'s rows');

        const erased = await accountData.erase([A]);
        assert.strictEqual(erased.erased.merchant_sources, 1);
        assert.strictEqual(Number(await d.db.value('SELECT count(*)::int FROM merchant_sources WHERE owner_sub = $1', [A])), 0, 'their claim is gone');
        assert.strictEqual(Number(await d.db.value('SELECT count(*)::int FROM merchant_sources WHERE owner_sub = $1', [B])), 1, 'Bo\'s claim stays');
        assert.strictEqual(Number(await d.db.value('SELECT enabled::int FROM sources WHERE key = $1', ['merchant-ada-ada'])), 0, 'the source it created stops being fetched');
        assert.ok(!String(await d.db.value('SELECT terms_note FROM sources WHERE key = $1', ['merchant-ada-ada'])).includes(A), 'the note no longer names them');
        console.log('  ✓ empty part, empty erase, the merchant claim, and the guard');
    } finally { await d.close(); }
})();
