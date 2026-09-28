'use strict';
/**
 * Per-actor rate limits (server/api/actor-limits.js, roadmap WS-R task 4): past its limit one principal
 * gets 429 problem+json `rate_limited` with Retry-After, before the route does any work, while another
 * still passes; the window reopens on the clock. A first-party service is not counted on reads (it
 * pulls for all its readers and editors); callers without a token get 401, never 429. Writes have their
 * own budgets. Health, ready, release.json and metrics are never limited; refusals are logged (no
 * token) and counted.
 */
const assert = require('assert');
const crypto = require('crypto');
const { serviceAuth } = require('openvibe-contracts');
const { boot, request, serviceToken, sourceDef, suite, ISSUER, privateKey, silent } = require('./helpers');

const t = suite('actor-limits');
// The limiter's clock: 15 s into a minute, so the minute window has 45 s left. Reads: 3 a minute.
let clock = Date.UTC(2026, 8, 27, 12, 0, 15);
const lines = [];
let svc;
const api = (method, p, opts = {}) => request(svc.base, method, p, opts);

function appToken(id, cap) {
    const now = Math.floor(Date.now() / 1000);
    return serviceAuth.signServiceToken({
        iss: ISSUER, sub: `app:app_${id}`, actor_type: 'app', aud: ['openvibe.sources'], cap, ns: [], iat: now, exp: now + 300,
        jti: `tok_${crypto.randomBytes(8).toString('hex')}`, project_id: 'prj_01J8ZQ4Y7N3M2K1H0G9F8E7D6C', env: 'production',
    }, privateKey);
}
const APP = appToken('01J8ZQ4Y7N3M2K1H0G9F8E7D6C', ['sources.source.read', 'sources.item.read']);
const OTHER_APP = appToken('01J8ZQ4Y7N3M2K1H0G9F8E7D6D', ['sources.source.read']);
const NEWS = serviceToken('news', ['sources.source.read', 'sources.item.read']);
const ADMIN = serviceToken('network', ['sources.source.manage']);
const STAFF_TOOL = serviceToken('admin-tools', ['sources.source.manage']);

t('boot', async () => {
    svc = await boot({ env: { SOURCES_LIMITS_MINUTE: '3', SOURCES_LIMITS_HOUR: '100' }, limitsNow: () => clock, log: { ...silent, warn: (m) => lines.push(String(m)) } });
});

t('an app reads 3 a minute, then 429 rate_limited with Retry-After; another app passes', async () => {
    for (let i = 0; i < 3; i++) assert.strictEqual((await api('GET', '/api/v1/sources', { token: APP })).status, 200, `read ${i + 1}`);
    const r = await api('GET', '/api/v1/items', { token: APP });
    assert.strictEqual(r.status, 429, r.text);
    assert.strictEqual(r.headers.get('retry-after'), '45');
    assert.match(r.headers.get('content-type'), /^application\/problem\+json/);
    assert.deepStrictEqual([r.body.code, r.body.status, r.body.retry_after_seconds], ['rate_limited', 429, 45]);
    assert.ok(r.body.detail.includes('sources.read'), r.body.detail);
    assert.strictEqual((await api('GET', '/api/v1/sources', { token: OTHER_APP })).status, 200, 'another app still passes');
});

t('a first-party service is not counted on reads; no token is 401, never 429', async () => {
    for (let i = 0; i < 8; i++) {
        assert.strictEqual((await api('GET', '/api/v1/items?category=news', { token: NEWS })).status, 200, `service read ${i + 1}`);
        assert.strictEqual((await api('GET', '/api/v1/sources')).status, 401);
    }
});

t('the next minute opens the window again', async () => {
    clock += 45 * 1000;
    assert.strictEqual((await api('GET', '/api/v1/sources', { token: APP })).status, 200);
});

t('source changes: 30 a minute per principal; nothing is stored past it; another staff tool passes', async () => {
    clock = Date.UTC(2026, 8, 27, 12, 5, 0);
    const count = async () => (await svc.db.prepare('SELECT COUNT(*) AS n FROM sources').get()).n;
    for (let i = 0; i < 30; i++) {
        const r = await api('POST', '/api/v1/sources', { token: ADMIN, body: sourceDef({ key: `limits-${i}`, enabled: false, endpoints: ['https://example.org/feed'] }) });
        assert.strictEqual(r.status, 201, `source ${i + 1}: ${r.text}`);
    }
    const before = await count();
    const r = await api('POST', '/api/v1/sources', { token: ADMIN, body: sourceDef({ key: 'one-too-many', enabled: false, endpoints: ['https://example.org/feed'] }) });
    assert.deepStrictEqual([r.status, r.body.code, r.headers.get('retry-after')], [429, 'rate_limited', '60']);
    assert.strictEqual(await count(), before, 'nothing stored');
    const other = await api('POST', '/api/v1/sources', { token: STAFF_TOOL, body: sourceDef({ key: 'other-tool', enabled: false, endpoints: ['https://example.org/feed'] }) });
    assert.strictEqual(other.status, 201, other.text);
});

t('fetch now has its own, tighter budget (10 a minute)', async () => {
    await api('POST', '/api/v1/sources', { token: STAFF_TOOL, body: { key: 'manual-codes', name: 'Codes', type: 'manual', category: 'coupons', terms_note: 'test', enabled: true } });
    for (let i = 0; i < 10; i++) assert.strictEqual((await api('POST', '/api/v1/sources/manual-codes/fetch', { token: ADMIN })).status, 409, `fetch ${i + 1}`);
    const r = await api('POST', '/api/v1/sources/manual-codes/fetch', { token: ADMIN });
    assert.deepStrictEqual([r.status, r.body.code], [429, 'rate_limited']);
});

t('health, ready, release.json, metrics and the home page are never limited', async () => {
    for (let i = 0; i < 6; i++) {
        assert.strictEqual((await api('GET', '/api/health')).status, 200);
        assert.notStrictEqual((await api('GET', '/api/ready')).status, 429);
        assert.strictEqual((await api('GET', '/release.json')).status, 200);
        assert.strictEqual((await api('GET', '/metrics')).status, 200);
        assert.strictEqual((await api('GET', '/')).status, 200);
    }
});

t('refusals are logged (the principal, never a token) and counted in sources_rate_limited_total', async () => {
    assert.ok(lines.includes('[limits] sources.read: app:app_01J8ZQ4Y7N3M2K1H0G9F8E7D6C refused, over 3 per minute'), lines.join('\n'));
    assert.ok(lines.includes('[limits] sources.source.manage: svc:network refused, over 30 per minute'), lines.join('\n'));
    assert.ok(!lines.some((l) => /Bearer|eyJ/.test(l)), 'no token in the log');
    const m = (await api('GET', '/metrics')).text;
    const found = m.split('\n').filter((l) => l.includes('sources_rate_limited_total')).join('\n');
    assert.ok(/sources_rate_limited_total\{limit="sources.read",window="minute"\} 1/.test(m), found);
    assert.ok(/sources_rate_limited_total\{limit="sources.source.manage",window="minute"\} 1/.test(m), found);
    assert.ok(/sources_rate_limited_total\{limit="sources.source.fetch",window="minute"\} 1/.test(m), found);
});

t('stop', async () => { await svc.stop(); });

t.run();
