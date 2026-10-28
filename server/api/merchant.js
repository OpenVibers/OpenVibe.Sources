'use strict';
/**
 * Merchant opt-in JSON API.
 *
 *   sources.source.read (or the merchant's own person token)
 *     GET  /api/v1/merchant/sources            the merchant's claims and sources, with last run/crawl stats
 *     GET  /api/v1/merchant/sources/:id
 *   sources.source.manage (or the merchant's own person token)
 *     POST   /api/v1/merchant/sources          add a domain and name its sitemap/product feed (pending)
 *     POST   /api/v1/merchant/sources/:id/verify
 *     POST   /api/v1/merchant/sources/:id/withdraw
 *
 * `/api/v1/merchant/claims` is an alias for the same collection (a claim is a source before verification). A first-party
 * service token must name the merchant with X-OV-Subject; a person token needs nothing else. Report calls the read with
 * its service token and the signed-in merchant's subject. The merchant dashboard itself lives in Report, not here.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { MerchantError, CHALLENGE_PREFIX, TXT_PREFIX, META_NAME } = require('../merchant');
const { CAPS } = require('../auth');
const { runView } = require('./sources');

const COLLECTION = ['/api/v1/merchant/sources', '/api/v1/merchant/claims'];
const ITEM = ['/api/v1/merchant/sources/:id', '/api/v1/merchant/claims/:id'];
const VERIFY = ['/api/v1/merchant/sources/:id/verify', '/api/v1/merchant/claims/:id/verify'];
const WITHDRAW = ['/api/v1/merchant/sources/:id/withdraw', '/api/v1/merchant/claims/:id/withdraw'];

function crawlSummary(crawl) {
    if (!crawl || crawl.not_crawl) return null;
    return {
        pages: crawl.pages,
        max_pages: crawl.max_pages,
        due: crawl.due,
        next_due_at: crawl.next_due_at,
        pages_by_state: crawl.pages_by_state,
        sitemaps_by_state: crawl.sitemaps_by_state,
        recent: (crawl.recent || []).slice(0, 5),
    };
}

function createMerchantView({ db, merchant, registry, ingest }) {
    return async function decorate(row) {
        const out = { ...merchant.view(row), source: null, last_run: null, last_crawl: null, recent_runs: [] };
        if (!row.source_key) return out;
        const source = await registry.get(row.source_key);
        if (!source) return out;
        out.source = registry.view(source);
        const runs = await db.prepare('SELECT * FROM fetch_runs WHERE source_key = ? ORDER BY rid DESC LIMIT 5').all(source.key);
        out.recent_runs = runs.map(runView);
        out.last_run = out.recent_runs[0] || null;
        if (source.type === 'crawl') {
            try { out.last_crawl = crawlSummary(await ingest.crawlStatus(source.key)); } catch { out.last_crawl = null; }
        }
        out.stats = {
            health: out.source.health,
            last_run: out.last_run,
            last_crawl: out.last_crawl,
            recent_runs: out.recent_runs,
        };
        return out;
    };
}

function merchantRouter({ db, merchant, registry, ingest, auth, merchantAuth, limits }) {
    const router = express.Router();
    const read = [merchantAuth.api(CAPS.read), limits.budget('sources.merchant.read')];
    const manage = [merchantAuth.api(CAPS.manage), limits.budget('sources.merchant.manage')];
    const decorate = createMerchantView({ db, merchant, registry, ingest });

    const fail = (res, req, err) => {
        if (err instanceof MerchantError) return http.sendProblem(res, err.status, err.code, { detail: err.message, ctx: req.ov });
        if (err && typeof err.code === 'string' && err.code.startsWith('sources.')) {
            return http.sendProblem(res, 422, err.code, { detail: err.message, ctx: req.ov });
        }
        throw err;
    };

    router.get(COLLECTION, read, async (req, res, next) => {
        try {
            const rows = await merchant.list(req.merchant);
            res.json({
                merchant: { subject: req.merchant.subject, name: req.merchant.name || null },
                sources: await Promise.all(rows.map(decorate)),
            });
        } catch (err) { next(err); }
    });

    router.get(ITEM, read, async (req, res, next) => {
        try {
            const row = await merchant.get(req.merchant, req.params.id);
            res.json({ merchant_source: await decorate(row) });
        } catch (err) {
            if (err instanceof MerchantError) return fail(res, req, err);
            next(err);
        }
    });

    router.post(COLLECTION, manage, async (req, res, next) => {
        try {
            const row = await merchant.add(req.merchant, req.body || {});
            res.status(201).json({
                merchant_source: await decorate(row),
                challenge: {
                    dns: { name: `${CHALLENGE_PREFIX}.${row.domain}`, value: `${TXT_PREFIX}${row.token}` },
                    meta: { name: META_NAME, value: row.token, url: row.meta_url || `https://${row.domain}/` },
                },
            });
        } catch (err) {
            if (err instanceof MerchantError) return fail(res, req, err);
            next(err);
        }
    });

    router.post(VERIFY, manage, async (req, res, next) => {
        try {
            const out = await merchant.verify(req.merchant, req.params.id);
            res.json({
                merchant_source: await decorate(out.row),
                verified: Boolean(out.verified),
                source_created: Boolean(out.source),
            });
        } catch (err) {
            if (err instanceof MerchantError) return fail(res, req, err);
            next(err);
        }
    });

    router.post(WITHDRAW, manage, async (req, res, next) => {
        try {
            const row = await merchant.withdraw(req.merchant, req.params.id);
            res.json({ merchant_source: await decorate(row) });
        } catch (err) {
            if (err instanceof MerchantError) return fail(res, req, err);
            next(err);
        }
    });

    return router;
}

module.exports = { merchantRouter, createMerchantView, crawlSummary };
