'use strict';
/**
 * Sources' secrets never leave in a response or an event, and its API answers nobody without a
 * valid service token (roadmap WS-R task 5: internal-secret leak; the private-bypass class for a
 * service whose every read is capability-gated). Sources boots with a sentinel as its Network OAuth
 * client secret (it mints its service token with it), a source whose endpoint carries a sentinel
 * credential in its query string (as a feed's API key would), and a failing fetch of it. Then every
 * route the booted app has (listed from Express's router stack) is requested anonymously, with a
 * garbage token, with another service's audience, with an expired token and with a read token,
 * with real and nonsense ids, plus the probes and every write route with a broken body. No body or
 * header may carry the client secret; only a caller holding sources.source.read may see a source's
 * endpoints (its admin); every /api/v1 route refuses the others; the outbox carries neither.
 *
 *   node test/security-secrets.test.js
 */
const assert = require('assert');
const { boot, site, sourceDef, rss, suite, serviceToken, request } = require('./helpers');

const t = suite('security-secrets');
const SECRET = 'sentinel-not-a-secret-sources-oauth-client';
const FEED_KEY = 'sentinel-not-a-secret-feed-key';
let svc, web;

function listRoutes(app) {
    const out = [];
    const mount = (layer) => {
        if (!layer.regexp || layer.regexp.fast_slash) return '';
        const src = layer.regexp.source.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/i, '').replace(/\\\//g, '/');
        return /[\\^$()|[\]*+?]/.test(src) ? null : src;
    };
    const walk = (stack, prefix) => {
        for (const layer of stack) {
            if (layer.route) for (const p of [].concat(layer.route.path)) { if (typeof p === 'string') out.push({ path: prefix + p, methods: Object.keys(layer.route.methods) }); }
            else if (layer.handle && Array.isArray(layer.handle.stack)) { const m = mount(layer); if (m !== null) walk(layer.handle.stack, prefix + m); }
        }
    };
    walk(app._router.stack, '');
    return out;
}
const fill = (p, v) => p.replace(/:([A-Za-z0-9_]+)/g, () => encodeURIComponent(v));

t('boot with a sentinel client secret and a source whose endpoint carries a key', async () => {
    web = await site({ '/robots.txt': () => ({ status: 404 }), '/feed.xml': () => ({ status: 500, body: 'upstream broke' }) });
    svc = await boot({ env: { OV_OAUTH_CLIENT_SECRET: SECRET, OV_OAUTH_CLIENT_ID: 'sources', OV_NETWORK_INTERNAL_URL: 'http://127.0.0.1:9' } });
    svc.registry.create(sourceDef({ key: 'keyed', endpoints: [`${web.origin}/feed.xml?api_key=${FEED_KEY}`] }), 'test');
    await svc.ingest.run('keyed', { trigger: 'manual' });
});

t('every route, as every kind of caller, with real and nonsense ids: the client secret never appears; the feed key only to a source reader', async () => {
    const now = Math.floor(Date.now() / 1000);
    const callers = {
        anonymous: null,
        garbage: 'not-a-token',
        'other audience': serviceToken('news', ['sources.*'], { aud: 'openvibe.elsewhere' }),
        expired: serviceToken('news', ['sources.*'], { exp: now - 60 }),
        'item reader': serviceToken('deals', ['sources.item.read']),
        'source reader': serviceToken('news', ['sources.source.read', 'sources.item.read']),
    };
    const found = [];
    const refusedApi = [];
    for (const route of listRoutes(svc.app)) {
        for (const method of route.methods) {
            for (const id of ['keyed', '1', 'nope', "'\"<x>", 'x'.repeat(300)]) {
                const p = fill(route.path, id);
                for (const [who, token] of Object.entries(callers)) {
                    const r = await request(svc.base, method.toUpperCase(), `${p}${method === 'get' ? '?q=x&limit=-1' : ''}`, { token, ...(method === 'get' ? {} : { headers: { 'content-type': 'application/json' } }) });
                    const text = r.text + JSON.stringify([...r.headers.entries()]);
                    if (text.includes(SECRET)) found.push(`${who}: ${method} ${p} → ${r.status} carries the client secret`);
                    if (text.includes(FEED_KEY) && who !== 'source reader') found.push(`${who}: ${method} ${p} → ${r.status} carries the feed key`);
                    if (p.startsWith('/api/v1/') && !/^\/api\/v1\/health/.test(p) && ['anonymous', 'garbage', 'other audience', 'expired'].includes(who) && r.status < 400) refusedApi.push(`${who}: ${method} ${p} → ${r.status}`);
                }
            }
        }
    }
    assert.deepStrictEqual(found, []);
    assert.deepStrictEqual(refusedApi, [], 'an /api/v1 route answered without a valid service token');
});

t('the outbox carries neither', () => {
    const rows = JSON.stringify(svc.outbox.all ? svc.outbox.all() : svc.db.prepare('SELECT * FROM event_outbox').all());
    assert.ok(!rows.includes(SECRET), 'client secret in the outbox');
    assert.ok(!rows.includes(FEED_KEY), 'feed key in the outbox');
});

t('done', async () => { await svc.stop(); await web.close(); });

t.run();
