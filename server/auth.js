'use strict';
/**
 * Service-token authentication and capability checks. Every API route is for services (other
 * OpenVibe services, or the Network admin surface acting through its own principal): an
 * RS256 client-credentials token from OpenVibe.Network (audience openvibe.sources), verified
 * offline, and ONE capability per route.
 *
 * The sources.* capabilities are proposed in docs/capabilities-proposal/ and are not in
 * openvibe-contracts v0.7.0 yet; checkCapability() decides them with the library's own grant rule
 * (exact id or a `family.*` grant) until a release knows them, then the library decides.
 */
const crypto = require('crypto');
const { serviceAuth, capabilities, http } = require('openvibe-contracts');

const CAPS = Object.freeze({
    read: 'sources.source.read',
    items: 'sources.item.read',
    manage: 'sources.source.manage',
});
const PROPOSED = new Set(Object.values(CAPS));

function createKeyStore({ urls = [], pem = null, fetchImpl = globalThis.fetch, log = console } = {}) {
    let key = pem ? toPem(pem) : null;
    let retryTimer = null;
    let refreshTimer = null;

    function toPem(value) {
        return crypto.createPublicKey(value).export({ type: 'spki', format: 'pem' });
    }

    async function fetchOnce() {
        for (const base of urls) {
            if (!base) continue;
            const url = `${base}/api/.well-known/jwks`;
            try {
                const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const body = await res.json();
                const jwk = (body.keys || []).find(k => k.kty === 'RSA');
                if (jwk) key = toPem({ key: jwk, format: 'jwk' });
                else if (typeof body.public_key === 'string' && body.public_key.includes('BEGIN')) key = toPem(body.public_key);
                else throw new Error('no RSA key in response');
                log.log(`[auth] Network public key loaded from ${base}`);
                return key;
            } catch (err) {
                log.warn(`[auth] key fetch from ${url} failed: ${err.message}`);
            }
        }
        return null;
    }

    function start() {
        if (pem) return Promise.resolve(key);
        const attempt = async () => {
            const k = await fetchOnce();
            if (!k && !key) {
                retryTimer = setTimeout(attempt, 30 * 1000);
                retryTimer.unref?.();
            }
            return k;
        };
        refreshTimer = setInterval(() => { fetchOnce().catch(() => {}); }, 6 * 60 * 60 * 1000);
        refreshTimer.unref?.();
        return attempt();
    }

    function stop() {
        clearTimeout(retryTimer);
        clearInterval(refreshTimer);
    }

    return { get: () => key, loaded: () => Boolean(key), start, stop };
}

function checkCapability(claims, capabilityId) {
    if (!capabilities.get(capabilityId) && PROPOSED.has(capabilityId)) {
        return capabilities.grants(claims && claims.cap, capabilityId)
            ? { allowed: true, code: null, reason: null }
            : { allowed: false, code: 'capability.denied', reason: `${capabilityId} not granted` };
    }
    return capabilities.check(claims, capabilityId);
}

function createAuth({ config, keys }) {
    /** Express guard: one capability. Sets req.principal = { sub, cap, jti }. */
    function requireCap(id) {
        return function capGuard(req, res, next) {
            const ctx = req.ov;
            const h = String(req.headers.authorization || '');
            if (!h.startsWith('Bearer ')) return http.sendProblem(res, 401, 'token.missing', { detail: 'a service token is required', ctx });
            const publicKey = keys.get();
            if (!publicKey) return http.sendProblem(res, 503, 'token.unavailable', { detail: 'signing key not loaded yet', ctx });
            const r = serviceAuth.verifyServiceToken(h.slice(7).trim(), { publicKey, issuer: config.issuer, audience: config.audience });
            if (!r.ok) return http.sendProblem(res, 401, r.code, { detail: r.reason, ctx });
            const c = checkCapability(r.claims, id);
            if (!c.allowed) return http.sendProblem(res, 403, c.code, { detail: c.reason, ctx });
            req.principal = { sub: r.claims.sub, cap: r.claims.cap, jti: r.claims.jti };
            return next();
        };
    }
    return { requireCap };
}

module.exports = { CAPS, PROPOSED, createKeyStore, createAuth, checkCapability };
