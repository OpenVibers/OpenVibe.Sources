'use strict';
/**
 * What sources.openvibe.network shows the public: a short honest page at / (HTML for browsers,
 * the text route index otherwise), never cached or indexed, with no JavaScript. The nginx vhost
 * (deploy/nginx/sources.openvibe.network.conf) keeps /api/v1/ loopback-only and answers every
 * other path with a JSON 404.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, request, suite } = require('./helpers');

const t = suite('public-host');
let svc;

t('boot', async () => { svc = await boot(); });

t('browsers get a short honest HTML page in the network\'s kit: internal service, nothing to browse, noindex, no-store, no inline script', async () => {
    const r = await request(svc.base, 'GET', '/', { headers: { Accept: 'text/html,application/xhtml+xml' } });
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.match(r.text, /internal service/);
    assert.match(r.text, /nothing to browse/);
    assert.match(r.text, /<meta name="robots" content="noindex, nofollow">/);
    assert.strictEqual(r.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.strictEqual(r.headers.get('cache-control'), 'no-store');
    assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
    // The kit's theme loader and kit-web from this host, and Cloudflare Web Analytics (injected at the edge); no inline script.
    assert.match(r.headers.get('content-security-policy'), /script-src 'self' https:\/\/static\.cloudflareinsights\.com;[^]*connect-src 'self' https:\/\/openvibe\.network https:\/\/cloudflareinsights\.com;/, 'the theme fetch from openvibe.network, and Cloudflare\'s report path on this host');
    assert.match(r.text, /<link rel="icon"[^>]*data-ov-icon="sources"/, 'the network\'s icon for Sources (no /favicon.ico 404)');
    for (const m of r.text.matchAll(/<script\b([^>]*)>/gi)) assert.match(m[1], /src="\/(?:shared\/|merchant\/arrival\.js)/, 'every script is served by this host');
    assert.match(r.headers.get('content-security-policy'), /frame-src https:\/\/openvibe\.network;/);
    assert.match(r.text, /src="\/merchant\/arrival\.js"/);
    assert.strictEqual((await request(svc.base, 'GET', '/merchant/arrival.js')).status, 200);
    assert.match(r.text, /<link rel="stylesheet" href="\/shared\/kit\.css">/, 'the network\'s kit');
    assert.match(r.text, /href="\/merchant"/, 'the merchant opt-in is one tap away');
    // The kit's files are served whether or not the merchant pages are on.
    assert.strictEqual((await request(svc.base, 'GET', '/shared/kit.css')).status, 200);
    const guest = await request(svc.base, 'GET', '/auth/me');
    assert.strictEqual(guest.status, 200);
    assert.deepStrictEqual(JSON.parse(guest.text), { user: null });
    assert.ok(!/admin/i.test(r.text));
});

t('other clients get the text route index', async () => {
    const r = await request(svc.base, 'GET', '/');
    assert.match(r.headers.get('content-type'), /text\/plain/);
    assert.match(r.text, /internal service/);
    assert.match(r.text, /GET {2}\/api\/v1\/sources/);
});

t('the vhost: wildcard certificate, client address from $remote_addr, /metrics 404, loopback-only API, JSON 404', () => {
    const conf = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'nginx', 'sources.openvibe.network.conf'), 'utf8');
    assert.match(conf, /ssl_certificate\s+\/etc\/letsencrypt\/live\/openvibe\.network\/fullchain\.pem;/);
    for (const h of ['X-Real-IP', 'X-Forwarded-For', 'CF-Connecting-IP']) assert.match(conf, new RegExp(`proxy_set_header ${h} \\$remote_addr;`));
    assert.ok(!/proxy_add_x_forwarded_for|\$http_cf_connecting_ip|\$http_x_forwarded_for/.test(conf), 'never a client-sent address');
    assert.match(conf, /location ~\* \^\/metrics\(\/\|\$\) \{ return 404; \}/, '/metrics is refused in any letter case');
    assert.match(conf, /location \^~ \/api\/v1\/ \{\s*allow 127\.0\.0\.1;\s*allow ::1;\s*deny all;/);
    assert.match(conf, /location \/ \{\s*default_type application\/problem\+json;\s*return 404 '\{/);
    const body = /return 404 '(\{.*\})';/.exec(conf)[1];
    assert.strictEqual(JSON.parse(body).status, 404);
});

t('shutdown', async () => { await svc.stop(); });

t.run();
