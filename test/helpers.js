'use strict';
/**
 * Shared test fixtures: a generated Network signing key, service token minting, a booted Sources
 * service on a random port with a temp database, and stub HTTP servers standing in for the
 * sites being ingested. Nothing here touches the internet.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nodeHttp = require('http');
const { serviceAuth } = require('openvibe-contracts');
const { load } = require('../server/config');
const { start } = require('../server/index');

const ISSUER = 'https://openvibe.network';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const silent = { log() {}, warn() {}, error(...a) { if (process.env.DEBUG) console.error(...a); } };

function serviceToken(slug, cap, { aud = 'openvibe.sources', exp = Math.floor(Date.now() / 1000) + 300, key = privateKey } = {}) {
    const now = Math.floor(Date.now() / 1000);
    return serviceAuth.signServiceToken({
        iss: ISSUER, sub: `svc:${slug}`, actor_type: 'service', aud: [aud], cap, ns: [], iat: now, exp,
        jti: `tok_${crypto.randomBytes(8).toString('hex')}`,
    }, key);
}

const made = [];
process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

function tmpDir() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-sources-test-'));
    made.push(d);
    return d;
}

/** Boot Sources; the scheduler is off unless worker: 'on'. Loopback is allowlisted for the stubs. */
async function boot({ env = {}, worker = 'off', lookupImpl, tokenClient } = {}) {
    const dir = tmpDir();
    const config = load({
        NODE_ENV: 'test',
        PORT: '0',
        SOURCES_DB_PATH: path.join(dir, 'sources.db'),
        OV_NETWORK_PUBLIC_KEY: publicKey,
        SOURCES_WORKER: worker,
        SOURCES_ALLOW_PRIVATE_HOSTS: '127.0.0.1',
        SOURCES_HOST_MIN_INTERVAL_MS: '0',
        SOURCES_FETCH_TIMEOUT_MS: '1500',
        SOURCES_TICK_MS: '50',
        ...env,
    });
    const h = await start({ config, log: silent, lookupImpl, tokenClient });
    const base = `http://127.0.0.1:${h.server.address().port}`;
    return { ...h, base, dir, async stop() { await h.close(); } };
}

async function request(base, method, p, { token, body, headers = {} } = {}) {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(base + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, body: json, text, headers: res.headers };
}

/**
 * A stub website. routes: { '/path': (req, res, ctx) => void | { status, headers, body, delayMs } }.
 * Every request is recorded with its headers and arrival time.
 */
async function site(routes = {}) {
    const requests = [];
    const server = nodeHttp.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://stub');
        requests.push({ path: url.pathname, search: url.search, headers: req.headers, at: Date.now() });
        const handler = routes[url.pathname] || routes['*'];
        if (!handler) { res.statusCode = 404; res.end('not found'); return; }
        const out = await handler(req, res, { url, count: requests.filter(r => r.path === url.pathname).length });
        if (!out || res.writableEnded) return;
        if (out.delayMs) await new Promise(r => setTimeout(r, out.delayMs));
        if (res.destroyed) return;
        res.writeHead(out.status || 200, out.headers || {});
        res.end(out.body === undefined ? '' : out.body);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${server.address().port}`;
    return {
        origin,
        requests,
        hits: (p) => requests.filter(r => r.path === p),
        routes,
        close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }),
    };
}

/** A minimal valid source definition pointing at a stub. */
function sourceDef(overrides = {}) {
    return {
        key: 'src-' + crypto.randomBytes(4).toString('hex'),
        name: 'Stub source',
        type: 'rss',
        category: 'news',
        endpoints: [],
        robots_note: 'robots.txt checked by the fetcher on every run',
        terms_note: 'test fixture',
        min_interval_ms: 0,
        poll_interval_sec: 3600,
        enabled: true,
        ...overrides,
    };
}

function rss(items) {
    return `<?xml version="1.0"?><rss version="2.0"><channel><title>Stub</title>${items.map(i =>
        `<item><title>${i.title}</title><link>${i.link}</link><guid isPermaLink="false">${i.guid}</guid>${i.date ? `<pubDate>${i.date}</pubDate>` : ''}<description>${i.description || ''}</description></item>`).join('')}</channel></rss>`;
}

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function suite(name) {
    const tests = [];
    const t = (n, fn) => tests.push([n, fn]);
    t.run = async () => {
        let failed = 0;
        for (const [n, fn] of tests) {
            try { await fn(); console.log(`  ok   ${n}`); } catch (err) { failed++; console.log(`  FAIL ${n}\n${err.stack}`); }
        }
        console.log(`${name}: ${tests.length - failed}/${tests.length} passed`);
        if (failed) process.exit(1);
    };
    return t;
}

module.exports = { ISSUER, privateKey, publicKey, silent, serviceToken, tmpDir, boot, request, site, sourceDef, rss, fixture, sleep, suite };
