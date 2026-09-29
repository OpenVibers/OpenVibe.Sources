'use strict';
/**
 * Service tokens are verified against Network's JWKS through openvibe-sdk/auth (plan T0/T1): the SDK
 * client fetches the keys, keeps them cached and keeps the last good ones through a JWKS outage, and
 * /api/ready reports its state. The stub JWKS helpers.boot starts serves the generated signing key;
 * nothing here touches the internet.
 *
 *   node test/auth-jwks.test.js
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot, serviceToken, request, suite } = require('./helpers');

const t = suite('auth-jwks');
const READER = serviceToken('news', ['sources.source.read']);

t('a token signed by a key from the stub JWKS verifies; one signed by another key does not', async () => {
    const svc = await boot();
    try {
        await svc.keyLoaded;
        const ok = await request(svc.base, 'GET', '/api/v1/sources', { token: READER });
        assert.strictEqual(ok.status, 200, ok.text);

        const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
        const forged = serviceToken('news', ['sources.source.read'], { key: other.privateKey });
        const bad = await request(svc.base, 'GET', '/api/v1/sources', { token: forged });
        assert.strictEqual(bad.status, 401, bad.text);
        assert.strictEqual(bad.body.code, 'token.bad_signature');
    } finally { await svc.stop(); }
});

t('with keys cached, a JWKS outage still verifies a token (the last good keys are served)', async () => {
    const svc = await boot();
    try {
        await svc.keyLoaded;
        await svc.jwksSite.close();   // Network is gone
        const r = await request(svc.base, 'GET', '/api/v1/sources', { token: serviceToken('news', ['sources.source.read']) });
        assert.strictEqual(r.status, 200, r.text);
        // Readiness still reports the cached keys rather than a dead service.
        const ready = await request(svc.base, 'GET', '/api/ready');
        assert.strictEqual(ready.body.checks.network_jwks.status, 'ok', ready.text);
    } finally { await svc.stop(); }
});

t('/api/ready carries the JWKS client state: ok with the keys, and degraded (200) while none has loaded', async () => {
    const svc = await boot();
    try {
        await svc.keyLoaded;
        const r = await request(svc.base, 'GET', '/api/ready');
        assert.strictEqual(r.status, 200, r.text);
        const c = r.body.checks.network_jwks;
        assert.strictEqual(c.required, false);
        assert.strictEqual(c.status, 'ok');
        // Counts and times only: the internal JWKS URL and the fetch error are never public.
        assert.strictEqual(c.detail.url, undefined);
        assert.strictEqual(c.detail.lastError, undefined);
        assert.ok(c.detail.keys >= 1, JSON.stringify(c.detail));
        assert.ok(c.detail.fetchedAt, JSON.stringify(c.detail));
    } finally { await svc.stop(); }

    // An unreachable JWKS: no keys, so the check degrades — the service still answers /api/ready 200.
    const dead = await boot({ env: { OV_NETWORK_JWKS_URL: 'http://127.0.0.1:9/api/.well-known/jwks' } });
    try {
        await dead.keyLoaded;
        const r = await request(dead.base, 'GET', '/api/ready');
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.body.checks.network_jwks.status, 'fail');
        assert.ok(r.body.degraded.includes('network_jwks'), r.text);
    } finally { await dead.stop(); }
});

t('an unreachable JWKS answers 503 without naming the URL or the fetch error — and neither does /api/ready', async () => {
    const jwksUrl = 'http://127.0.0.1:9/api/.well-known/jwks';
    const svc = await boot({ env: { OV_NETWORK_JWKS_URL: jwksUrl } });
    try {
        await svc.keyLoaded;
        const r = await request(svc.base, 'GET', '/api/v1/sources', { token: serviceToken('news', ['sources.source.read']) });
        assert.strictEqual(r.status, 503, r.text);
        assert.strictEqual(r.body.code, 'token.unavailable', r.text);
        assert.strictEqual(r.body.detail, 'signing key not loaded yet', r.text);
        for (const leak of ['127.0.0.1:9', 'ECONNREFUSED', 'fetch failed', 'jwks']) {
            assert.ok(!r.text.includes(leak), `the 503 body names ${leak}: ${r.text}`);
        }

        // Readiness degrades (200, the check is optional) and says nothing about the URL or the error.
        const ready = await request(svc.base, 'GET', '/api/ready');
        assert.strictEqual(ready.status, 200, ready.text);
        const c = ready.body.checks.network_jwks;
        assert.strictEqual(c.status, 'fail');
        assert.ok(ready.body.degraded.includes('network_jwks'), ready.text);
        for (const leak of ['127.0.0.1:9', 'ECONNREFUSED', 'fetch failed', '/api/.well-known/jwks']) {
            assert.ok(!ready.text.includes(leak), `/api/ready names ${leak}: ${ready.text}`);
        }
        // It still reports the counts (0 keys, a growing failure count) — that is all it is allowed to say.
        assert.strictEqual(c.detail.keys, 0, ready.text);
        assert.ok(c.detail.failures >= 1, ready.text);
    } finally { await svc.stop(); }
});

t.run();
