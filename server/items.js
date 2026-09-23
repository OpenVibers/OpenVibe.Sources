'use strict';
/**
 * Source items: provenance-carrying records of what a source said, when we retrieved it, and
 * from which exact body and parser.
 *
 * Every item stores its source key, canonical URL, retrieval time (first seen, last seen), a
 * content hash of the parsed fields, the hash of the raw body it was parsed from, the parser
 * version and the source's license/terms notes as they were at ingestion. A changed content hash
 * is a new revision (the previous one stays in item_revisions); an unchanged item only has its
 * retrieval time refreshed. Removal (a takedown, a licence problem) is explicit, audited and
 * sticky: a later fetch that still lists the item does not bring it back.
 *
 * Only successful fetches reach ingest(); nothing in this module runs for a failed fetch.
 */
const { ids } = require('openvibe-contracts');
const { nextSeq } = require('./db');
const { sha256, canonicalJson } = require('./adapters/util');

const STAFF_GROUPS = ['role:admin', 'role:global_mod'];

function contentHash(it) {
    return sha256(canonicalJson({
        kind: it.kind, canonical_url: it.canonical_url || null, title: it.title || null, summary: it.summary || null,
        authors: it.authors || [], published_at: it.published_at || null, updated_at: it.updated_at || null, fields: it.fields || {},
    }));
}

function createItems({ db, outbox, now = () => Date.now() }) {
    const st = {
        byIdentity: db.prepare('SELECT * FROM items WHERE source_key = ? AND identity = ?'),
        byId: db.prepare('SELECT * FROM items WHERE id = ?'),
        insert: db.prepare(`INSERT INTO items (id, source_key, category, identity, kind, canonical_url, title, summary, authors, published_at,
            source_updated_at, fields, content_hash, raw_body_hash, parser_version, license_note, terms_note, first_seen_at, retrieved_at,
            revision, last_fetch_run_id, entered_by, change_seq)
            VALUES (@id, @source_key, @category, @identity, @kind, @canonical_url, @title, @summary, @authors, @published_at,
            @source_updated_at, @fields, @content_hash, @raw_body_hash, @parser_version, @license_note, @terms_note, @first_seen_at, @retrieved_at,
            1, @last_fetch_run_id, @entered_by, @change_seq)`),
        update: db.prepare(`UPDATE items SET kind = @kind, canonical_url = @canonical_url, title = @title, summary = @summary, authors = @authors,
            published_at = @published_at, source_updated_at = @source_updated_at, fields = @fields, content_hash = @content_hash,
            raw_body_hash = @raw_body_hash, parser_version = @parser_version, license_note = @license_note, terms_note = @terms_note,
            retrieved_at = @retrieved_at, revision = revision + 1, last_fetch_run_id = @last_fetch_run_id, change_seq = @change_seq
            WHERE id = @id`),
        seen: db.prepare('UPDATE items SET retrieved_at = ?, last_fetch_run_id = ? WHERE id = ?'),
        remove: db.prepare('UPDATE items SET removed_at = ?, removed_reason = ?, revision = revision + 1, change_seq = ? WHERE id = ?'),
        revision: db.prepare(`INSERT INTO item_revisions (item_id, revision, content_hash, raw_body_hash, parser_version, fetch_run_id, retrieved_at, snapshot)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
        revisions: db.prepare('SELECT * FROM item_revisions WHERE item_id = ? ORDER BY revision'),
    };

    function view(row) {
        if (!row) return null;
        const iso = (v) => (v == null ? null : new Date(v).toISOString());
        return {
            id: row.id,
            source_key: row.source_key,
            category: row.category,
            kind: row.kind,
            identity: row.identity,
            canonical_url: row.canonical_url,
            title: row.title,
            summary: row.summary,
            authors: JSON.parse(row.authors),
            published_at: row.published_at,
            source_updated_at: row.source_updated_at,
            fields: JSON.parse(row.fields),
            revision: row.revision,
            provenance: {
                retrieved_at: iso(row.retrieved_at),
                first_seen_at: iso(row.first_seen_at),
                content_hash: row.content_hash,
                raw_body_hash: row.raw_body_hash,
                parser_version: row.parser_version,
                fetch_run_id: row.last_fetch_run_id,
                license_note: row.license_note,
                terms_note: row.terms_note,
                entered_by: row.entered_by,
            },
            removed: row.removed_at ? { at: iso(row.removed_at), reason: row.removed_reason } : null,
            change_seq: row.change_seq,
        };
    }

    function subjectOf(row) {
        return { type: 'item', id: row.id, revision: row.revision };
    }

    function itemEvent(type, row, extra = {}) {
        outbox.enqueue({
            event_type: type,
            subject: subjectOf(row),
            payload: {
                item_id: row.id, source_key: row.source_key, category: row.category, kind: row.kind,
                canonical_url: row.canonical_url, title: row.title, revision: row.revision, content_hash: row.content_hash,
                retrieved_at: new Date(row.retrieved_at).toISOString(), ...extra,
            },
        });
    }

    /** search.index-document@1 for a raw item: staff-only, never indexable, provenance attached. */
    function indexDocument(row) {
        const title = row.title || row.canonical_url || row.identity;
        const doc = {
            owner: 'sources', type: 'item', id: row.id, revision: row.revision,
            visibility: 'members', acl: { groups: STAFF_GROUPS },
            title: String(title).slice(0, 500),
            summary: row.summary ? row.summary.slice(0, 4000) : '',
            body: '',
            facets: { category: row.category, source: row.source_key, kind: row.kind },
            authorship: 'imported',
            provenance: [{
                service: 'sources', type: 'item', id: row.id, revision: row.revision,
                ...(row.canonical_url ? { url: row.canonical_url } : {}),
                retrieved_at: new Date(row.retrieved_at).toISOString(),
            }],
            publication_state: 'published',
            published_at: row.published_at || null,
            updated_at: row.source_updated_at || null,
            indexability: { decision: 'noindex', reasons: ['third_party_content'] },
        };
        if (row.canonical_url) doc.canonical_url = row.canonical_url;
        return doc;
    }

    function indexEvent(source, row, deleted = false) {
        if (!source.search_visibility) return;
        outbox.enqueue({
            event_type: deleted ? 'sources.index_document.deleted' : 'sources.index_document.upserted',
            subject: subjectOf(row),
            payload: deleted ? { type: 'item', id: row.id, revision: row.revision } : indexDocument(row),
        });
    }

    function snapshot(row) {
        return JSON.stringify({
            kind: row.kind, canonical_url: row.canonical_url, title: row.title, summary: row.summary,
            authors: JSON.parse(row.authors), published_at: row.published_at, source_updated_at: row.source_updated_at, fields: JSON.parse(row.fields),
        });
    }

    function values(source, it, ctx) {
        return {
            kind: it.kind,
            canonical_url: it.canonical_url || null,
            title: it.title || null,
            summary: it.summary || null,
            authors: JSON.stringify(it.authors || []),
            published_at: it.published_at || null,
            source_updated_at: it.updated_at || null,
            fields: JSON.stringify(it.fields || {}),
            content_hash: contentHash(it),
            raw_body_hash: ctx.rawBodyHash || null,
            parser_version: ctx.parserVersion,
            license_note: source.license_note || null,
            terms_note: source.terms_note || null,
            retrieved_at: ctx.retrievedAt,
            last_fetch_run_id: ctx.runId || null,
        };
    }

    /**
     * Apply one successful fetch's parsed items. Must run inside the transaction that also writes
     * the fetch run row. → { created, updated, unchanged, skipped }
     */
    function ingest(source, parsedItems, ctx) {
        if (!db.inTransaction) throw new Error('items.ingest() must run inside the fetch run transaction');
        const counts = { created: 0, updated: 0, unchanged: 0, skipped: 0 };
        for (const it of parsedItems) {
            const cur = st.byIdentity.get(source.key, it.identity);
            const v = values(source, it, ctx);
            if (!cur) {
                const row = { id: `itm_${ids.ulid(ctx.retrievedAt)}`, source_key: source.key, category: source.category, identity: it.identity, first_seen_at: ctx.retrievedAt, entered_by: ctx.enteredBy || null, change_seq: nextSeq(db, 'items'), ...v };
                st.insert.run(row);
                const saved = st.byId.get(row.id);
                st.revision.run(saved.id, 1, saved.content_hash, saved.raw_body_hash, saved.parser_version, ctx.runId || null, ctx.retrievedAt, snapshot(saved));
                itemEvent('sources.item.created', saved);
                indexEvent(source, saved);
                counts.created++;
            } else if (cur.removed_at) {
                counts.skipped++;           // removal is sticky
            } else if (cur.content_hash !== v.content_hash) {
                st.update.run({ ...v, id: cur.id, change_seq: nextSeq(db, 'items') });
                const saved = st.byId.get(cur.id);
                st.revision.run(saved.id, saved.revision, saved.content_hash, saved.raw_body_hash, saved.parser_version, ctx.runId || null, ctx.retrievedAt, snapshot(saved));
                itemEvent('sources.item.updated', saved, { previous_content_hash: cur.content_hash });
                indexEvent(source, saved);
                counts.updated++;
            } else {
                st.seen.run(ctx.retrievedAt, ctx.runId || null, cur.id);
                counts.unchanged++;
            }
        }
        return counts;
    }

    /** Remove an item (takedown, licence, error). Sticky; emits sources.item.removed. */
    function remove(source, id, reason, by) {
        return db.transaction(() => {
            const cur = st.byId.get(id);
            if (!cur || cur.source_key !== source.key) return null;
            if (cur.removed_at) return view(cur);
            const t = now();
            st.remove.run(t, `${reason}${by ? ` (by ${by})` : ''}`.slice(0, 500), nextSeq(db, 'items'), id);
            const saved = st.byId.get(id);
            st.revision.run(saved.id, saved.revision, saved.content_hash, saved.raw_body_hash, saved.parser_version, null, t, JSON.stringify({ removed: true, reason }));
            itemEvent('sources.item.removed', saved, { reason });
            indexEvent(source, saved, true);
            return view(saved);
        })();
    }

    function get(id, { revisions = false } = {}) {
        const row = st.byId.get(id);
        if (!row) return null;
        const out = view(row);
        if (revisions) {
            out.revisions = st.revisions.all(id).map(r => ({
                revision: r.revision, content_hash: r.content_hash, raw_body_hash: r.raw_body_hash, parser_version: r.parser_version,
                fetch_run_id: r.fetch_run_id, retrieved_at: new Date(r.retrieved_at).toISOString(), snapshot: JSON.parse(r.snapshot),
            }));
        }
        return out;
    }

    /** Items in change order (created, updated or removed after `after`). */
    function list({ source = null, category = null, after = 0, limit = 100, includeRemoved = false } = {}) {
        const rows = db.prepare(`SELECT * FROM items WHERE change_seq > @after
            AND (@source IS NULL OR source_key = @source) AND (@category IS NULL OR category = @category)
            AND (@incl = 1 OR removed_at IS NULL)
            ORDER BY change_seq LIMIT @limit`).all({ after, source, category, incl: includeRemoved ? 1 : 0, limit: limit + 1 });
        const more = rows.length > limit;
        const page = rows.slice(0, limit);
        // next_after is where to resume, also when this page is the last one (poll with it later).
        return { items: page.map(view), next_after: page.length ? page[page.length - 1].change_seq : after, more };
    }

    return { ingest, remove, get, list, view, indexDocument, contentHash };
}

module.exports = { createItems, contentHash, STAFF_GROUPS };
