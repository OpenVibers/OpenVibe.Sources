'use strict';
/**
 * Merchant authentication for the opt-in flow.
 *
 *   API  `/api/v1/merchant/*`
 *     - a person's Network session token in `Authorization: Bearer` (the merchant owns the claims); or
 *     - a first-party service token with `sources.source.read` / `sources.source.manage` and X-OV-Subject,
 *       the way OpenVibe.Space lets a first-party service act for a person. An app/module token cannot delegate.
 *   Pages `/merchant/*`
 *     - the Sources first-party `ov_token` cookie, set by the OAuth callback below and verified offline with
 *       openvibe-sdk/auth verifyUserToken. There is no client-side token storage.
 *
 * The OAuth client (`OV_OAUTH_CLIENT_ID`, default `sources`) must be registered at OpenVibe.Network with
 * `<BASE_URL>/merchant/callback` as a redirect URI. Forms carry an HMAC CSRF token bound to the merchant subject;
 * cookies are httpOnly, SameSite=Lax, Secure in production.
 *
 * The handshake itself (authorize URL with state and PKCE S256, the code exchange, GET /auth/health) is
 * openvibe-sdk/sso's. The merchant's own session (`ov_token`, held by the pages, no refresh token) and its
 * CSRF token stay here: a merchant session is not a site-wide staff sign-in and must not share either.
 */
const crypto = require('crypto');
const { http, ids } = require('openvibe-contracts');
const { createSsoClient } = require('openvibe-sdk/sso');
const { checkCapability } = require('./auth');

const ACCESS_COOKIE = 'ov_token';
const STATE_COOKIE = 'ov_merchant_state';
const VERIFIER_COOKIE = 'ov_merchant_verifier';
const NEXT_COOKIE = 'ov_merchant_next';
const FLOW_MAX_AGE = 10 * 60 * 1000;
const SESSION_MAX_AGE = 24 * 3600 * 1000;
const PRINCIPAL_SUB = /^(svc|app|mod|node|agent):/;

function decodePayload(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
}

function cookie(req, name) {
    const m = String((req && req.headers && req.headers.cookie) || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    if (!m) return null;
    try { return decodeURIComponent(m[1]); } catch { return null; }
}

function bearer(req) {
    const h = String((req && req.headers && req.headers.authorization) || '');
    return h.startsWith('Bearer ') ? h.slice(7).trim() || null : null;
}

/** Only a same-site merchant path is a post-sign-in destination. */
function safeNext(value) {
    const n = String(value == null ? '' : value);
    if (!n || /[\u0000-\u001f\u007f\\]/.test(n)) return '/merchant';
    if (n === '/') return '/';
    if (!/^\/merchant(?:\/|$|\?|#)/.test(n)) return '/merchant';
    return n;
}

function createMerchantAuth({ config, auth, log = console, fetchImpl = globalThis.fetch }) {
    const secret = config.merchant.sessionSecret;
    const secure = Boolean(config.cookies && config.cookies.secure);
    const baseCookie = { sameSite: 'lax', secure, httpOnly: true, path: '/' };
    const flowCookie = { sameSite: 'lax', secure, httpOnly: true, path: '/merchant', maxAge: FLOW_MAX_AGE };
    const sso = createSsoClient({
        site: 'sources',
        siteName: 'OpenVibe.Sources',
        baseUrl: config.baseUrl,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        networkUrl: config.networkUrl,
        networkInternalUrl: config.networkInternalUrl,
        issuer: config.issuer,
        redirectUri: config.oauth.redirectUri,
        scope: config.oauth.scope || 'profile',
        secureCookies: secure,
        fetch: fetchImpl,
        log,
    });

    const csrfFor = (subject) => crypto.createHmac('sha256', secret).update(`sources-merchant:${subject}`).digest('base64url').slice(0, 32);

    function checkCsrf(principal, token) {
        if (!principal || !principal.subject || typeof token !== 'string') return false;
        const expected = csrfFor(principal.subject);
        const a = Buffer.from(expected);
        const b = Buffer.from(token);
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    }

    function setSession(res, token) {
        res.cookie(ACCESS_COOKIE, token, { ...baseCookie, maxAge: SESSION_MAX_AGE });
    }

    function clearSession(res) {
        res.clearCookie(ACCESS_COOKIE, { ...baseCookie, maxAge: undefined });
    }

    async function resolvePage(req) {
        const token = bearer(req) || cookie(req, ACCESS_COOKIE);
        if (!token) return null;
        const payload = decodePayload(token);
        if (payload && (payload.actor_type || PRINCIPAL_SUB.test(String(payload.sub || '')))) return null;
        const u = await auth.verifyUser(token);
        if (!u) return null;
        return { subject: u.subject, name: u.name, kind: 'user', claims: u.claims };
    }

    /** Attach req.merchant when the page cookie is a live person session; anonymous stays anonymous. */
    async function page(req, _res, next) {
        try {
            const merchant = await resolvePage(req);
            if (merchant) {
                req.merchant = merchant;
                req.principal = { sub: `user:${merchant.subject}` };
            }
            return next();
        } catch (err) { return next(err); }
    }

    function requirePage(req, res, next) {
        if (req.merchant) return next();
        const nextPath = req.method === 'GET' || req.method === 'HEAD' ? safeNext(req.originalUrl) : '/merchant';
        return res.redirect(303, `/merchant/login?next=${encodeURIComponent(nextPath)}`);
    }

    function problem(res, req, status, code, detail) {
        return http.sendProblem(res, status, code, { detail, ctx: req.ov });
    }

    /**
     * API guard: a person's token (owner) or a first-party service token with `cap` plus X-OV-Subject. Sets
     * req.merchant = { subject, name, kind } and req.principal for the per-actor limiter.
     */
    function api(cap) {
        return async function merchantGuard(req, res, next) {
            const token = bearer(req);
            if (!token) return problem(res, req, 401, 'token.missing', 'a merchant session or a service token is required');
            const payload = decodePayload(token);
            const principalToken = payload && (payload.actor_type || PRINCIPAL_SUB.test(String(payload.sub || '')));
            try {
                if (principalToken) {
                    const r = await auth.verifyService(token);
                    if (!r.ok) return problem(res, req, r.code === 'token.unavailable' ? 503 : 401, r.code, r.reason);
                    const c = checkCapability(r.claims, cap);
                    if (!c.allowed) return problem(res, req, 403, c.code, c.reason);
                    const delegated = req.get('x-ov-subject') || req.query.subject || null;
                    if (!delegated) return problem(res, req, 400, 'merchant.subject_required', 'a first-party service must name the merchant with X-OV-Subject');
                    if (!String(r.claims.sub).startsWith('svc:')) return problem(res, req, 403, 'merchant.subject_forbidden', 'only a first-party service may act for a person');
                    if (!ids.isSubjectId('user', String(delegated))) return problem(res, req, 400, 'merchant.subject_invalid', 'X-OV-Subject must be a usr_… subject id');
                    req.merchant = { subject: String(delegated), name: null, kind: 'service', service: r.claims.sub };
                    req.principal = { sub: r.claims.sub, cap: r.claims.cap, jti: r.claims.jti };
                    return next();
                }
                const u = await auth.verifyUser(token);
                if (!u) return problem(res, req, 401, 'merchant.auth_required', 'the bearer token is not a valid OpenVibe person session');
                req.merchant = { subject: u.subject, name: u.name, kind: 'user', claims: u.claims };
                req.principal = { sub: `user:${u.subject}` };
                return next();
            } catch (err) { return next(err); }
        };
    }

    async function login(req, res) {
        const next = safeNext(req.query.next);
        const existing = await resolvePage(req);
        if (existing) return res.redirect(303, next);
        // openvibe-sdk/sso: state + PKCE S256. The verifier rides the same /merchant flow cookie.
        const started = sso.authorizeUrl({ silent: req.query.silent === '1' });
        res.cookie(STATE_COOKIE, started.state, flowCookie);
        res.cookie(VERIFIER_COOKIE, started.verifier, flowCookie);
        res.cookie(NEXT_COOKIE, next, flowCookie);
        return res.redirect(started.url);
    }

    async function callback(req, res) {
        const { code, state, error } = req.query;
        const next = safeNext(cookie(req, NEXT_COOKIE));
        const expected = cookie(req, STATE_COOKIE);
        const verifier = cookie(req, VERIFIER_COOKIE);
        res.clearCookie(STATE_COOKIE, { ...flowCookie, maxAge: undefined });
        res.clearCookie(VERIFIER_COOKIE, { ...flowCookie, maxAge: undefined });
        res.clearCookie(NEXT_COOKIE, { ...flowCookie, maxAge: undefined });
        if (error) return res.redirect(303, `/merchant?auth_error=${encodeURIComponent(String(error).slice(0, 80))}&sso=none`);
        // The state (constant time) and the PKCE verifier must both come from this browser.
        if (!code || !state || !expected || !verifier || String(state).length !== String(expected).length
            || !crypto.timingSafeEqual(Buffer.from(String(state)), Buffer.from(String(expected)))) {
            return res.status(400).type('html').send('<!doctype html><meta charset="utf-8"><title>Sign-in failed</title><p>The sign-in response did not match this browser. <a href="/merchant/login">Try again</a>.</p>');
        }
        try {
            const data = await sso.tokenGrant({
                grant_type: 'authorization_code',
                redirect_uri: config.oauth.redirectUri,
                code: String(code),
                code_verifier: verifier,
            });
            const u = await auth.verifyUser(data.access_token);
            if (!u) throw Object.assign(new Error('the Network returned a token without a person subject'), { status: 401 });
            setSession(res, data.access_token);
            res.cookie('ov_sso_hint', 'account', { sameSite: 'lax', secure, httpOnly: false, path: '/', maxAge: SESSION_MAX_AGE });
            return res.redirect(303, next);
        } catch (err) {
            log.error(`[merchant] sign-in failed: ${err.message}`);
            return res.status(502).type('html').send('<!doctype html><meta charset="utf-8"><title>Sign-in failed</title><p>OpenVibe.Network could not complete the sign-in. <a href="/merchant/login">Try again</a>.</p>');
        }
    }

    function logout(req, res) {
        clearSession(res);
        res.cookie('ov_sso_hint', 'guest', { sameSite: 'lax', secure, httpOnly: false, path: '/', maxAge: SESSION_MAX_AGE });
        return res.redirect(303, '/merchant');
    }

    /** 'ok' | 'invalid' | 'unknown': does the Network accept this site's OAuth client? (GET /auth/health) */
    function checkClient() {
        return sso.checkClient();
    }

    return {
        api, page, requirePage, login, callback, logout, checkClient,
        resolvePage, checkCsrf, csrfFor, setSession, clearSession,
        ACCESS_COOKIE, STATE_COOKIE, NEXT_COOKIE, safeNext,
    };
}

module.exports = { createMerchantAuth, safeNext, decodePayload, cookie, bearer };
