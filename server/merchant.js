'use strict';
/**
 * Merchant opt-in ("List your store on OpenVibe", plan §4.4 channel 1).
 *
 * A signed-in merchant adds a domain, proves control of it (the OpenVibe.Space pattern: a DNS TXT record at
 * _openvibe-sources.<domain>, or a meta tag on a page of the domain), and names the sitemap or product feed Sources may
 * read. Nothing enters `sources` before the proof is present: a pending claim lives only in `merchant_sources`. On
 * verification one enabled source is created in the same transaction, and its terms_note records who gave the explicit
 * permission, when, and how control was verified. Withdrawal disables that source and keeps the note (and the claim) as
 * the audit trail. The fetcher/crawler still obeys robots.txt on every request; explicit permission is not a robots
 * override.
 *
 * The challenge is a random token in a public DNS/meta record. It is not a credential and is shown only to the owner (or
 * a first-party service acting for them, with X-OV-Subject).
 *
 * ADR 0007 still governs technique: this is a source whose access verdict is the merchant's explicit proof, not a probe
 * of a site we have no permission from; every request it causes goes through the same fetcher, UA, robots and spacing.
 */
const crypto = require('crypto');
const dns = require('dns');
const { ids } = require('openvibe-contracts');
const { decodeBody, decodeEntities } = require('./adapters/util');

const CHALLENGE_PREFIX = '_openvibe-sources';
const TXT_PREFIX = 'openvibe-sources-verification=';
const META_NAME = 'openvibe-sources-verification';
const METHODS = ['dns', 'meta'];
const LISTING_KINDS = ['sitemap', 'feed'];
const DAY = 24 * 3600 * 1000;

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME_RE = new RegExp(`^(?:${LABEL}\\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$`);
const RESERVED_SUFFIXES = ['.local', '.internal', '.localhost', '.test', '.invalid', '.example', '.onion', '.home.arpa'];
const ID_RE = /^msrc_[0-9A-HJKMNP-TV-Z]{26}$/;

class MerchantError extends Error {
    constructor(status, code, detail) { super(detail); this.status = status; this.code = code; }
}

const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const iso = (v) => (v == null ? null : new Date(Number(v)).toISOString());

function isHostname(h) {
    return typeof h === 'string' && h.length <= 253 && HOSTNAME_RE.test(h);
}

/** A claimed domain: lowercase, no port, a real DNS name, not an OpenVibe property or a reserved name. */
function checkDomain(raw) {
    const domain = String(raw || '').trim().toLowerCase().replace(/\.$/, '');
    if (!isHostname(domain)) throw new MerchantError(422, 'merchant.domain_invalid', 'the domain must be a fully qualified host name such as shop.example.org');
    if (RESERVED_SUFFIXES.some(s => domain.endsWith(s))) throw new MerchantError(422, 'merchant.domain_reserved', `${domain} is a reserved name and cannot be claimed`);
    if (/(^|\.)openvibe\./.test(domain)) throw new MerchantError(422, 'merchant.domain_reserved', `${domain} is an OpenVibe domain and cannot be claimed`);
    return domain;
}

/** A URL the merchant names: http(s), no credentials, at most 2048 characters, no secret-looking query parameter. */
function checkUrl(raw, what) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s || s.length > 2048) throw new MerchantError(422, 'merchant.url_invalid', `${what} must be an http(s) URL of at most 2048 characters`);
    let u;
    try { u = new URL(s); } catch { throw new MerchantError(422, 'merchant.url_invalid', `${what} is not a URL`); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new MerchantError(422, 'merchant.url_invalid', `${what} must be http(s)`);
    if (u.username || u.password) throw new MerchantError(422, 'merchant.url_invalid', `${what} must not carry credentials`);
    for (const k of u.searchParams.keys()) {
        if (/^(api[_-]?key|apikey|key|token|access[_-]?token|auth|secret|client[_-]?secret|password|passwd|sig|signature)$/i.test(k)) {
            throw new MerchantError(422, 'merchant.url_secret', `${what} must not carry a credential in its query string`);
        }
    }
    u.hash = '';
    return u.toString();
}

/** The claimed domain and a URL's host are the same site: the domain, its www twin, or a subdomain of it. */
function sameSite(domain, host) {
    const d = String(domain || '').toLowerCase().replace(/\.$/, '');
    const h = String(host || '').toLowerCase().replace(/\.$/, '');
    if (!d || !h) return false;
    return h === d || h === `www.${d}` || d === `www.${h}` || h.endsWith(`.${d}`);
}

function sourceKeyFor(row) {
    const slug = String(row.domain).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '') || 'site';
    const suffix = String(row.id).replace(/^msrc_/, '').slice(-8).toLowerCase();
    return `merchant-${slug}-${suffix}`;
}

/** The explicit-permission note products read: who, when, how, and that withdrawal is possible. */
function termsNoteFor(row, verifiedAt) {
    const who = row.owner_name ? `${row.owner_sub} (${clip(row.owner_name, 80)})` : row.owner_sub;
    const how = row.method === 'dns'
        ? `a DNS TXT record at ${CHALLENGE_PREFIX}.${row.domain}`
        : `a meta tag at ${clip(row.meta_url || `https://${row.domain}/`, 400)}`;
    const what = row.listing_kind === 'sitemap' ? 'sitemap' : 'product feed';
    return clip(`Merchant opt-in: ${who} gave OpenVibe explicit permission on ${iso(verifiedAt)} to list ${row.domain} from the ${what} at ${clip(row.listing_url, 500)}, verified by ${how}. The merchant may withdraw this permission, which disables this source; robots.txt is still checked on every request.`, 2000);
}

/** The source definition created only after the proof. A sitemap becomes a crawl; a feed uses the feed adapter. */
function sourceFor(row, termsNote, config) {
    const crawl = row.listing_kind === 'sitemap';
    const atom = !crawl && /\.atom(?:\.xml)?$/i.test(new URL(row.listing_url).pathname);
    const m = config.merchant;
    return {
        key: sourceKeyFor(row),
        name: clip(row.store_name || `${row.domain} (merchant opt-in)`, 200),
        type: crawl ? 'crawl' : (atom ? 'atom' : 'rss'),
        category: 'deals',
        homepage_url: `https://${row.domain}/`,
        endpoints: [row.listing_url],
        auth: { mode: 'none' },
        robots_note: 'robots.txt is checked on every request and every redirect hop; a disallowed page is not fetched.',
        terms_note: termsNote,
        license_note: null,
        min_interval_ms: crawl ? m.crawlMinIntervalMs : m.feedMinIntervalMs,
        poll_interval_sec: m.pollIntervalSec,
        stale_after_sec: crawl ? m.crawlStaleAfterSec : m.feedStaleAfterSec,
        max_items: Math.min(m.maxItems, config.items.maxPerFetch),
        enabled: true,
        review_required: false,
        sensitivity: 'none',
        default_indexability: 'index',
        search_visibility: null,
        retire_after_sec: null,
        crawl: crawl ? {
            // The merchant named this sitemap: follow it (and any sitemap index below it), not other sitemaps found by guess.
            sitemaps: false,
            follow_links: false,
            include: [],
            exclude: [],
            max_pages: m.crawlMaxPages,
            pages_per_run: m.crawlPagesPerRun,
            recrawl_sec: m.crawlRecrawlSec,
            max_depth: 0,
            require_structured: true,
        } : null,
    };
}

function defaultResolver(servers) {
    const r = new dns.promises.Resolver({ timeout: 5000, tries: 2 });
    if (servers && servers.length) r.setServers(servers);
    return { resolveTxt: (name) => r.resolveTxt(name) };
}

/** True when the page carries <meta name="openvibe-sources-verification" content="<token>">, in any attribute order. */
function hasVerificationMeta(html, token) {
    const ATTR = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
    for (const tag of String(html || '').match(/<meta\b[^>]*>/gi) || []) {
        const attrs = {};
        let m;
        ATTR.lastIndex = 0;
        while ((m = ATTR.exec(tag))) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
        const name = attrs.name || attrs.property || '';
        if (name.trim().toLowerCase() === META_NAME && decodeEntities(attrs.content || '').trim() === token) return true;
    }
    return false;
}

function createMerchant({ db, config, registry, fetcher, resolver = null, now = () => Date.now(), log = console }) {
    const dnsResolver = resolver || defaultResolver(config.merchant.dnsServers);
    const q = {
        byId: db.prepare('SELECT * FROM merchant_sources WHERE id = ?'),
        liveForDomain: db.prepare("SELECT * FROM merchant_sources WHERE domain = ? AND status IN ('pending','verified')"),
        forOwner: db.prepare('SELECT * FROM merchant_sources WHERE owner_sub = ? ORDER BY created_at DESC, id DESC'),
        insert: db.prepare(`INSERT INTO merchant_sources
            (id, owner_sub, owner_name, store_name, domain, method, token, listing_url, listing_kind, meta_url, status,
             created_at, updated_at)
            VALUES (@id, @owner_sub, @owner_name, @store_name, @domain, @method, @token, @listing_url, @listing_kind, @meta_url,
             'pending', @now, @now)`),
        checked: db.prepare(`UPDATE merchant_sources SET last_checked_at = ?, check_count = check_count + 1,
            last_error = ?, updated_at = ? WHERE id = ?`),
        verified: db.prepare(`UPDATE merchant_sources SET status = 'verified', source_key = ?, terms_note = ?, verified_at = ?,
            verified_by = ?, verification_detail = ?, last_checked_at = ?, check_count = check_count + 1, last_error = NULL,
            updated_at = ? WHERE id = ? AND status = 'pending'`),
        failed: db.prepare("UPDATE merchant_sources SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ? AND status = 'pending'"),
        withdraw: db.prepare(`UPDATE merchant_sources SET status = 'withdrawn', withdrawn_at = ?, withdrawn_by = ?, updated_at = ?
            WHERE id = ? AND status != 'withdrawn'`),
        duePending: db.prepare(`SELECT * FROM merchant_sources WHERE status = 'pending'
            AND COALESCE(last_checked_at, 0) < ? ORDER BY COALESCE(last_checked_at, 0), created_at LIMIT ?`),
    };

    function view(row) {
        if (!row) return null;
        const challenge = row.method === 'dns'
            ? { type: 'TXT', name: `${CHALLENGE_PREFIX}.${row.domain}`, value: `${TXT_PREFIX}${row.token}`, note: 'Publish this record, then check now. You can remove it after verification.' }
            : { type: 'meta', name: META_NAME, value: row.token, url: row.meta_url || `https://${row.domain}/`, html: `<meta name="${META_NAME}" content="${row.token}">` };
        return {
            id: row.id,
            domain: row.domain,
            status: row.status,
            owner: { subject: row.owner_sub, name: row.owner_name || null },
            store_name: row.store_name || null,
            method: row.method,
            listing: { kind: row.listing_kind, url: row.listing_url },
            meta_url: row.meta_url || null,
            source_key: row.source_key || null,
            terms_note: row.terms_note || null,
            verification: {
                method: row.method,
                challenge,
                verified_at: iso(row.verified_at),
                verified_by: row.verified_by || null,
                detail: row.verification_detail || null,
                last_checked_at: iso(row.last_checked_at),
                check_count: Number(row.check_count || 0),
                last_error: row.last_error || null,
            },
            withdrawal: row.withdrawn_at ? { at: iso(row.withdrawn_at), by: row.withdrawn_by || null } : null,
            created_at: iso(row.created_at),
            updated_at: iso(row.updated_at),
        };
    }

    async function load(principal, id) {
        if (!principal || !ids.isSubjectId('user', principal.subject)) throw new MerchantError(401, 'merchant.auth_required', 'a signed-in merchant is required');
        if (!ID_RE.test(String(id || ''))) throw new MerchantError(404, 'merchant.not_found', 'no such merchant source');
        const row = await q.byId.get(id);
        if (!row || row.owner_sub !== principal.subject) throw new MerchantError(404, 'merchant.not_found', 'no such merchant source');
        return row;
    }

    async function add(principal, input = {}) {
        if (!principal || !ids.isSubjectId('user', principal.subject)) throw new MerchantError(401, 'merchant.auth_required', 'a signed-in merchant is required');
        const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
        const domain = checkDomain(body.domain ?? body.hostname ?? body.host);
        const method = String(body.method ?? body.verification_method ?? '').trim().toLowerCase();
        if (!METHODS.includes(method)) throw new MerchantError(422, 'merchant.method_invalid', 'method must be dns or meta');
        const listingKind = String(body.listing_kind || body.listing || (body.sitemap_url ? 'sitemap' : '') || (body.feed_url ? 'feed' : '')).trim().toLowerCase();
        if (!LISTING_KINDS.includes(listingKind)) throw new MerchantError(422, 'merchant.listing_invalid', 'listing_kind must be sitemap or feed');
        const listingUrl = checkUrl(body.listing_url ?? body.url ?? body.sitemap_url ?? body.feed_url, 'listing_url');
        if (!sameSite(domain, new URL(listingUrl).hostname)) throw new MerchantError(422, 'merchant.listing_host', `the ${listingKind} must be on ${domain} or one of its subdomains`);
        let metaUrl = null;
        if (method === 'meta') {
            const chosenMeta = body.meta_url ?? body.verification_url;
            metaUrl = chosenMeta ? checkUrl(chosenMeta, 'meta_url') : `https://${domain}/`;
            if (!sameSite(domain, new URL(metaUrl).hostname)) throw new MerchantError(422, 'merchant.meta_host', `the meta tag page must be on ${domain} or one of its subdomains`);
        } else if (body.meta_url || body.verification_url) {
            throw new MerchantError(422, 'merchant.meta_unused', 'meta_url is only for method meta');
        }
        if ((body.store_name != null && typeof body.store_name !== 'string') || (body.name != null && typeof body.name !== 'string')) {
            throw new MerchantError(422, 'merchant.store_name_invalid', 'store_name must be text');
        }
        const storeName = body.store_name == null && body.name == null ? null : clip(body.store_name ?? body.name, 120) || null;

        const live = await q.liveForDomain.get(domain);
        if (live) {
            if (live.owner_sub === principal.subject) throw new MerchantError(409, 'merchant.exists', `${domain} already has a ${live.status} claim on this account`);
            throw new MerchantError(409, 'merchant.domain_taken', `${domain} is already claimed`);
        }
        const t = now();
        const row = {
            id: `msrc_${ids.ulid(t)}`,
            owner_sub: principal.subject,
            owner_name: principal.name ? clip(principal.name, 80) : null,
            store_name: storeName,
            domain,
            method,
            token: crypto.randomBytes(20).toString('hex'),
            listing_url: listingUrl,
            listing_kind: listingKind,
            meta_url: metaUrl,
            now: t,
        };
        try { await q.insert.run(row); } catch (err) {
            if (err && err.code === '23505') throw new MerchantError(409, 'merchant.domain_taken', `${domain} is already claimed`);
            throw err;
        }
        return await q.byId.get(row.id);
    }

    async function lookupDns(row) {
        let records;
        try { records = await dnsResolver.resolveTxt(`${CHALLENGE_PREFIX}.${row.domain}`); } catch (err) {
            const code = err && err.code;
            if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NXDOMAIN') {
                return { ok: false, error: `no TXT record at ${CHALLENGE_PREFIX}.${row.domain} yet` };
            }
            return { ok: false, error: `DNS lookup failed (${code || 'error'})` };
        }
        const values = (records || []).map(chunks => (Array.isArray(chunks) ? chunks.join('') : String(chunks)));
        const expected = `${TXT_PREFIX}${row.token}`;
        if (values.includes(expected)) return { ok: true, detail: `DNS TXT record ${CHALLENGE_PREFIX}.${row.domain} matched` };
        return { ok: false, error: values.length ? `${CHALLENGE_PREFIX}.${row.domain} has TXT records, but not the expected value` : `no TXT record at ${CHALLENGE_PREFIX}.${row.domain} yet` };
    }

    async function lookupMeta(row) {
        const urls = row.meta_url ? [row.meta_url] : [`https://${row.domain}/`, `http://${row.domain}/`];
        let lastError = `no meta tag at ${urls[0]}`;
        for (const url of urls) {
            try {
                const res = await fetcher.fetchUrl(url, {
                    headers: { Accept: 'text/html, application/xhtml+xml;q=0.9, */*;q=0.1' },
                    capBytes: config.merchant.metaMaxBytes,
                    timeoutMs: config.merchant.metaTimeoutMs,
                });
                if (res.status !== 200) { lastError = `HTTP ${res.status} at ${url}`; continue; }
                const finalHost = new URL(res.finalUrl || url).hostname;
                if (!sameSite(row.domain, finalHost)) { lastError = `redirected outside ${row.domain} (${finalHost})`; continue; }
                const text = decodeBody(res.body, res.headers['content-type']);
                if (hasVerificationMeta(text, row.token)) return { ok: true, detail: `meta tag at ${url} matched` };
                lastError = `no ${META_NAME} meta tag at ${url}`;
            } catch (err) {
                lastError = `${url}: ${err.code || 'fetch failed'}`;
            }
        }
        return { ok: false, error: lastError };
    }

    /** Check the proof and, when present, create the source in the same transaction that verifies the claim. */
    async function check(row, actor) {
        const result = row.method === 'dns' ? await lookupDns(row) : await lookupMeta(row);
        const checkedAt = now();
        if (!result.ok) {
            await q.checked.run(checkedAt, clip(result.error, 500) || 'not verified', checkedAt, row.id);
            return { row: await q.byId.get(row.id), verified: false, source: null };
        }
        const terms = termsNoteFor(row, checkedAt);
        const sourceInput = sourceFor(row, terms, config);
        let source = null;
        try {
            await db.tx(async () => {
                const fresh = await db.prepare('SELECT * FROM merchant_sources WHERE id = ? FOR UPDATE').get(row.id);
                if (!fresh || fresh.status !== 'pending') return;
                source = await registry.create(sourceInput, fresh.owner_sub);
                const changed = await q.verified.run(source.key, terms, checkedAt, actor && actor.subject ? actor.subject : fresh.owner_sub,
                    clip(result.detail, 500), checkedAt, checkedAt, row.id);
                if (!changed || changed.changes === 0) throw new Error('the claim changed while it was being verified');
            });
        } catch (err) {
            await q.checked.run(now(), clip(`verification found the proof, but the source was not created: ${err.message}`, 500), now(), row.id);
            if (err && typeof err.code === 'string' && err.code.startsWith('sources.')) {
                throw new MerchantError(422, err.code, `the source was not created: ${err.message}`);
            }
            throw err;
        }
        const final = await q.byId.get(row.id);
        return { row: final, verified: Boolean(final && final.status === 'verified'), source };
    }

    async function verify(principal, id) {
        const row = await load(principal, id);
        if (row.status === 'verified') return { row, verified: true, source: null, already: true };
        if (row.status === 'withdrawn') throw new MerchantError(409, 'merchant.withdrawn', 'this claim was withdrawn; add the domain again to opt in');
        if (row.status === 'failed') throw new MerchantError(409, 'merchant.failed', 'this claim failed before verification; add the domain again to opt in');
        return await check(row, principal);
    }

    async function withdraw(principal, id) {
        const row = await load(principal, id);
        if (row.status === 'withdrawn') return row;
        const t = now();
        await db.tx(async () => {
            if (row.source_key) {
                const source = await registry.get(row.source_key);
                // The terms note stays as it was: the history of the permission is the point.
                if (source) await registry.patch(row.source_key, { enabled: false }, principal.subject);
            }
            await q.withdraw.run(t, principal.subject, t, row.id);
        });
        return await q.byId.get(row.id);
    }

    async function list(principal) {
        if (!principal || !ids.isSubjectId('user', principal.subject)) throw new MerchantError(401, 'merchant.auth_required', 'a signed-in merchant is required');
        return await q.forOwner.all(principal.subject);
    }

    /** Worker pass: pending claims are checked again; a claim that never verifies fails after merchant.pendingDays. */
    async function recheck({ limit = 50 } = {}) {
        const t = now();
        const summary = { checked: 0, verified: 0, failed: 0 };
        for (const row of await q.duePending.all(t - config.merchant.recheckIntervalMs + 1000, limit)) {
            if (t - row.created_at > config.merchant.pendingDays * DAY) {
                await q.failed.run(`not verified within ${config.merchant.pendingDays} days`, t, row.id);
                summary.failed++;
                continue;
            }
            try {
                const out = await check(row, { subject: 'svc:sources' });
                summary.checked++;
                if (out.row && out.row.status === 'verified') summary.verified++;
            } catch (err) {
                log.error(`[merchant] recheck ${row.id}: ${err.stack || err}`);
            }
        }
        return summary;
    }

    return {
        add, list, load, verify, withdraw, recheck, view,
        get: async (principal, id) => await load(principal, id),
        getById: async (id) => (ID_RE.test(String(id || '')) ? await q.byId.get(id) || null : null),
    };
}

module.exports = {
    createMerchant, MerchantError, checkDomain, checkUrl, sameSite, sourceKeyFor, termsNoteFor, hasVerificationMeta,
    isHostname, CHALLENGE_PREFIX, TXT_PREFIX, META_NAME, METHODS, LISTING_KINDS,
};
