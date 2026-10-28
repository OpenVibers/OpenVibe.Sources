'use strict';
/**
 * The merchant opt-in pages (plain forms, no client-side state). The JSON API and these pages share server/merchant.js:
 * the page is the signed-in merchant's front door, and the API is what Report calls later.
 *
 *   GET  /merchant                     the merchant's claims, or the guest explanation
 *   GET  /merchant/sources/:id         proof instructions, status, terms note and last crawl
 *   POST /merchant/sources             add a domain (CSRF)
 *   POST /merchant/sources/:id/verify  check the proof now (CSRF)
 *   POST /merchant/sources/:id/withdraw disable the source and keep the note (CSRF)
 *   GET  /merchant/login|callback|logout
 */
const express = require('express');
const { MerchantError } = require('./merchant');
const views = require('./views/merchant');
const { createMerchantView } = require('./api/merchant');

const NOTICES = {
    created: 'Domain added. Publish the proof below, then check now. Nothing is fetched or enabled before the proof is found.',
    verified: 'Proof found. Your source was created and enabled.',
    pending: 'The proof was not found yet. Publish it and check again.',
    withdrawn: 'Permission withdrawn. The source is disabled and its terms note is kept.',
};

function merchantPages({ db, merchant, registry, ingest, merchantAuth, limits, log = console }) {
    const router = express.Router();
    const decorate = createMerchantView({ db, merchant, registry, ingest });
    const readLimit = limits.budget('sources.merchant.read');
    const manageLimit = limits.budget('sources.merchant.manage');

    const noticeFor = (query) => Object.keys(NOTICES).filter(k => query[k] != null && query[k] !== '0').map(k => NOTICES[k]).join(' ');
    const send = (res, status, html) => res.status(status).type('html').send(html);

    async function listPage(req, res, status = 200, extra = {}) {
        const claims = req.merchant ? await Promise.all((await merchant.list(req.merchant)).map(decorate)) : [];
        return send(res, status, views.merchantPage({
            merchant: req.merchant,
            claims,
            csrf: req.merchant ? merchantAuth.csrfFor(req.merchant.subject) : '',
            notice: noticeFor(req.query),
            authError: req.query.auth_error ? String(req.query.auth_error).slice(0, 80) : '',
            ...extra,
        }));
    }

    async function detailPage(req, res, status = 200, extra = {}) {
        const row = await merchant.get(req.merchant, req.params.id);
        return send(res, status, views.detailPage({
            merchant: req.merchant,
            claim: await decorate(row),
            csrf: merchantAuth.csrfFor(req.merchant.subject),
            notice: noticeFor(req.query),
            noticeKind: req.query.pending != null && req.query.pending !== '0' ? 'warn' : 'ok',
            ...extra,
        }));
    }

    function csrfOk(req) {
        return merchantAuth.checkCsrf(req.merchant, req.body && req.body.csrf);
    }

    router.get('/', readLimit, async (req, res, next) => {
        try {
            if (!req.merchant) {
                return send(res, 200, views.guestPage({
                    authError: req.query.auth_error ? String(req.query.auth_error).slice(0, 80) : '',
                }));
            }
            return await listPage(req, res);
        } catch (err) { next(err); }
    });

    router.get('/login', async (req, res, next) => {
        try { await merchantAuth.login(req, res); } catch (err) { next(err); }
    });
    router.get('/callback', async (req, res, next) => {
        try { await merchantAuth.callback(req, res); } catch (err) { next(err); }
    });
    router.get('/logout', (req, res) => merchantAuth.logout(req, res));

    router.get('/sources', (req, res) => res.redirect(303, '/merchant'));
    router.get('/sources/:id', merchantAuth.requirePage, readLimit, async (req, res, next) => {
        try { return await detailPage(req, res); } catch (err) {
            if (err instanceof MerchantError) return send(res, err.status, views.errorPage({ status: err.status, message: err.message }).html);
            next(err);
        }
    });

    router.post('/sources', merchantAuth.requirePage, manageLimit, async (req, res, next) => {
        try {
            if (!csrfOk(req)) return send(res, 403, views.errorPage({ status: 403, message: 'This form expired or did not come from this page. Reload and try again.' }).html);
            const row = await merchant.add(req.merchant, req.body || {});
            return res.redirect(303, `/merchant/sources/${row.id}?created=1`);
        } catch (err) {
            if (err instanceof MerchantError) {
                try { return await listPage(req, res, err.status, { error: err.message }); } catch (inner) { return next(inner); }
            }
            next(err);
        }
    });

    router.post('/sources/:id/verify', merchantAuth.requirePage, manageLimit, async (req, res, next) => {
        try {
            if (!csrfOk(req)) return send(res, 403, views.errorPage({ status: 403, message: 'This form expired or did not come from this page. Reload and try again.' }).html);
            const out = await merchant.verify(req.merchant, req.params.id);
            const verified = out.row && out.row.status === 'verified';
            return res.redirect(303, `/merchant/sources/${out.row.id}?${verified ? 'verified=1' : 'pending=1'}`);
        } catch (err) {
            if (err instanceof MerchantError) {
                try { return await detailPage(req, res, err.status, { error: err.message }); } catch (inner) { return next(inner); }
            }
            next(err);
        }
    });

    router.post('/sources/:id/withdraw', merchantAuth.requirePage, manageLimit, async (req, res, next) => {
        try {
            if (!csrfOk(req)) return send(res, 403, views.errorPage({ status: 403, message: 'This form expired or did not come from this page. Reload and try again.' }).html);
            const row = await merchant.withdraw(req.merchant, req.params.id);
            return res.redirect(303, `/merchant/sources/${row.id}?withdrawn=1`);
        } catch (err) {
            if (err instanceof MerchantError) {
                try { return await detailPage(req, res, err.status, { error: err.message }); } catch (inner) { return next(inner); }
            }
            next(err);
        }
    });

    // A page error is HTML, not a JSON problem: the merchant can read it and go back.
    router.use((err, req, res, _next) => {
        if (res.headersSent) return res.end();
        log.error(`[merchant] ${req.method} ${req.originalUrl}: ${err.stack || err}`);
        return send(res, 500, views.errorPage({ status: 500, message: 'Something went wrong on our side. Please try again.' }).html);
    });

    return router;
}

module.exports = { merchantPages, NOTICES };
