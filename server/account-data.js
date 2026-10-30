'use strict';
/**
 * Account export and deletion → Sources (ADR-033; openvibe-sdk/account-data).
 *
 * Sources keeps the outside web's records: registries, items, fetch runs and robots policies. None of them names a
 * Network person; a source is keyed by its host and the item by its URL.
 *
 * The one row that does is the merchant opt-in (merchant_sources): the signed-in merchant's own claim, with the
 * challenge they proved, their name and the permission note that names them. Their claim goes with the account, and
 * the source it created stops being fetched, because the permission it rests on is gone. The note goes too: it holds
 * the person's name in free text, which a kept row may not (ADR-033).
 *
 * So a person's export part carries their merchant claims (never the challenge token) and their deletion confirms
 * what it erased. Telemetry samples that name a person are covered by the SDK itself (telemetry.json, then subject NULL).
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

const TABLES = [];

// The merchant's own claim. The challenge token is never exported; their name and subject are in Network's part.
const CLAIM_COLUMNS = ['id', 'store_name', 'domain', 'method', 'listing_url', 'listing_kind', 'meta_url', 'status', 'source_key',
    'terms_note', 'verified_at', 'verified_by', 'verification_detail', 'last_checked_at', 'check_count', 'created_at', 'withdrawn_at'];

/** The claims the person made, without the challenge that proves them. */
async function extraExport(db, subject) {
    const claims = await db.many(`SELECT ${CLAIM_COLUMNS.join(', ')} FROM merchant_sources WHERE owner_sub = $1 ORDER BY created_at DESC LIMIT 5000`, [subject]);
    return claims.length ? [{ name: 'merchant-sources.json', content: claims }] : [];
}

/** The claim goes, and the source it created stops being fetched (its note named the person). */
async function extraErase(t, subjects, counts) {
    const rows = await t.many('SELECT id, source_key FROM merchant_sources WHERE owner_sub = ANY($1::text[])', [subjects]);
    if (!rows.length) return;
    const keys = rows.map((r) => r.source_key).filter(Boolean);
    if (keys.length) {
        counts.add(counts.retained, 'sources_disabled', await t.exec(
            `UPDATE sources SET enabled = 0, terms_note = 'Merchant opt-in withdrawn: the merchant closed their account.', updated_at = $2 WHERE key = ANY($1::text[])`,
            [keys, Date.now()]));
    }
    counts.add(counts.erased, 'merchant_sources', await t.exec('DELETE FROM merchant_sources WHERE owner_sub = ANY($1::text[])', [subjects]));
}

function create({ db, log = console } = {}) {
    return createAccountData({ db, service: 'sources', tables: TABLES, extraExport, extraErase, log });
}

module.exports = { create, TABLES, TOPICS, extraExport, extraErase };
