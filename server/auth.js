'use strict';
/**
 * Service-token authentication and capability checks. API routes for services (other OpenVibe
 * services, or the Network admin surface acting through its own principal) use an RS256
 * client-credentials token from OpenVibe.Network (audience openvibe.sources), verified offline
 * against Network's JWKS (openvibe-sdk/auth, one client per URL, kept fresh and served through an
 * outage), and ONE capability per route.
 *
 * The merchant opt-in routes also accept a person's Network session token (the same RS256 key and
 * issuer, no `typ`, a usr_… `subject_id`): the merchant is the owner of the claim. Pages use the
 * same verification on their own first-party cookie. A first-party service may act for a person
 * only through the X-OV-Subject header (server/merchant-auth.js), as OpenVibe.Space does.
 *
 * The sources.* capabilities are released in openvibe-contracts (docs/capabilities-proposal/ is
 * kept in step with those manifests), so the library's own grant rule decides every one: an exact
 * id or a `family.*` grant, and capability.unknown for an id it does not know.
 */
const { serviceAuth, capabilities, http, ids } = require('openvibe-contracts');
const { jwksClient, verifyUserToken } = require('openvibe-sdk/auth');

const CAPS = Object.freeze({
    read: 'sources.source.read',
    items: 'sources.item.read',
    manage: 'sources.source.manage',
});

function checkCapability(claims, capabilityId) {
    return capabilities.check(claims, capabilityId);
}

function createAuth({ config, log = console, jwks = null }) {
    const headerKid = (token) => { try { return JSON.parse(Buffer.from(String(token).split('.')[0], 'base64url').toString('utf8')).kid || null; } catch { return null; } };
    const userKeys = jwks || jwksClient(config.jwksUrl, { log });

    /** { ok, claims } or { ok: false, code, reason }. The SDK's error names the internal JWKS URL: logged, never answered. */
    async function verifyService(token) {
        const kid = headerKid(token);
        let keys;
        try { keys = await jwksClient(config.jwksUrl, { log }).keysForKid(kid); } catch (err) {
            log.error(`[auth] Network keys unavailable: ${(err && err.message) || err}`);
            return { ok: false, code: 'token.unavailable', reason: 'signing key not loaded yet' };
        }
        const byKid = kid ? keys.filter((k) => k.kid === kid) : [];
        let last = { ok: false, code: 'token.unavailable', reason: 'signing key not loaded yet' };
        for (const k of byKid.length ? byKid : keys) {
            last = serviceAuth.verifyServiceToken(token, { publicKey: k.key, issuer: config.issuer, audience: config.audience });
            if (last.ok || last.code !== 'token.bad_signature') return last;
        }
        return last;
    }

    /**
     * A person's Network session token → { claims, subject: usr_…, name } or null. Typed tokens (FedCM assertions,
     * realtime tickets) and service/app principals are refused by verifyUserToken; the subject must be a usr_ id.
     */
    async function verifyUser(token) {
        if (!token) return null;
        try {
            const claims = await verifyUserToken(String(token), { jwks: userKeys, issuer: config.issuer });
            const subject = ids.isSubjectId('user', claims.subject_id) ? claims.subject_id
                : (ids.isSubjectId('user', claims.sub) ? claims.sub : null);
            if (!subject) return null;
            return { claims, subject, name: claims.username || claims.display_name || claims.name || null };
        } catch {
            return null;
        }
    }

    /** Express guard: one capability. Sets req.principal = { sub, cap, jti }. */
    function requireCap(id) {
        return async function capGuard(req, res, next) {
            const ctx = req.ov;
            const h = String(req.headers.authorization || '');
            if (!h.startsWith('Bearer ')) return http.sendProblem(res, 401, 'token.missing', { detail: 'a service token is required', ctx });
            // The keys come from the SDK's JWKS client (one per URL, started at boot: the last good keys through a
            // Network outage, a rotation honoured on an unknown kid); every token rule is openvibe-contracts'
            // verifyServiceToken (identity.service-token-claims@1, sandbox refused, issuer, audience, expiry).
            let r;
            try { r = await verifyService(h.slice(7).trim()); } catch (err) { return next(err); }
            if (!r.ok) return http.sendProblem(res, r.code === 'token.unavailable' ? 503 : 401, r.code, { detail: r.reason, ctx });
            const claims = r.claims;
            const c = checkCapability(claims, id);
            if (!c.allowed) return http.sendProblem(res, 403, c.code, { detail: c.reason, ctx });
            req.principal = { sub: claims.sub, cap: claims.cap, jti: claims.jti };
            return next();
        };
    }
    return { requireCap, verifyService, verifyUser };
}

module.exports = { CAPS, createAuth, checkCapability };
