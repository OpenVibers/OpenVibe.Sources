'use strict';
/**
 * Sources fetches the URLs its registry names, and those come from people (source proposals, the
 * API): no fetch may reach an internal address, however it is spelled (roadmap WS-R task 5, the
 * SSRF class). robots-ssrf.test.js pins the guard's basics (a table of addresses, loopback and
 * metadata refused, a name resolving inward refused at connect time, a redirect to 10.0.0.5); this
 * suite covers the class:
 *
 *   - the guard's address rule agrees with openvibe-shared/egress's (the platform's rule, which
 *     Live, Events, Chat and Tools use) on every address in a wide table, so the two cannot drift
 *     apart (Media's copy had: roadmap WS-R task 5, Media 1157a54);
 *   - every spelling of an internal address in an endpoint (decimal, octal, hex, short IPv4, 0,
 *     IPv6 loopback/unspecified/mapped in both notations, NAT64, 6to4, ULA, link-local, metadata,
 *     private and CGNAT ranges) and non-http schemes are refused before any connection;
 *   - a name whose DNS answers include ANY internal address (mixed answers, mapped IPv6, NAT64) is
 *     refused where the connection is made;
 *   - a redirect to each spelling is refused at that hop, and the internal target is never hit;
 *   - a source registered over the API with internal endpoints is stored but its fetch is refused;
 *   - a ratchet over the files that make outbound requests themselves.
 *
 *   node test/security-ssrf.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const shared = require('openvibe-shared/egress');
const { createGuard, isPublicAddress } = require('../server/net/guard');
const { boot, site, sourceDef, rss, suite, serviceToken, request } = require('./helpers');

const t = suite('security-ssrf');
const FEED = rss([{ guid: 'x', title: 'X', link: 'https://example.org/x' }]);
let web, port;

const ADDRESSES = [
    '0.0.0.0', '0.1.2.3', '10.0.0.1', '100.64.0.1', '100.127.255.254', '127.0.0.1', '127.255.255.254', '169.254.169.254', '172.16.0.1', '172.31.255.254',
    '192.0.0.1', '192.0.2.1', '192.168.1.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::127.0.0.1', '::7f00:1', '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '64:ff9b:1::a00:1',
    '2002:7f00:1::', '2002:a9fe:a9fe::1', '2001::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001:db8::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fec0::1', 'ff02::1',
    '0:0:0:0:0:ffff:7f00:1', '0000:0000:0000:0000:0000:0000:0000:0001',
    '8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8',
];

t('the guard\'s address rule agrees with openvibe-shared/egress on every address', () => {
    const differ = ADDRESSES.filter((a) => isPublicAddress(a) !== shared.isPublicAddress(a)).map((a) => `${a}: sources ${isPublicAddress(a)}, shared ${shared.isPublicAddress(a)}`);
    assert.deepStrictEqual(differ, []);
    for (const a of ['127.0.0.1', '::ffff:127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::', '169.254.169.254', '::']) assert.strictEqual(isPublicAddress(a), false, a);
});

t('every spelling of an internal address, and every non-http scheme, is refused before any connection', () => {
    const guard = createGuard({ allowPrivateHosts: [], allowedPorts: [80, 443, 8080] });
    for (const u of ['http://127.0.0.1/', 'http://2130706433/', 'http://0177.0.0.1/', 'http://0x7f000001/', 'http://0x7f.1/', 'http://127.1/', 'http://0/', 'http://0.0.0.0/',
        'http://[::1]/', 'http://[::]/', 'http://[::ffff:127.0.0.1]/', 'http://[0:0:0:0:0:ffff:7f00:1]/', 'http://[::ffff:7f00:1]/', 'http://[64:ff9b::7f00:1]/',
        'http://[2002:7f00:1::]/', 'http://[fd00::1]/', 'http://[fe80::1]/', 'http://169.254.169.254/latest/meta-data/', 'http://[::ffff:a9fe:a9fe]/', 'http://10.0.0.1/',
        'http://172.16.0.1/', 'http://192.168.1.1/', 'http://100.64.0.1/', 'file:///etc/passwd', 'gopher://127.0.0.1:70/', 'ftp://127.0.0.1/', 'http://user:pw@example.org/',
        'http://example.org:22/', 'http://example.org:6379/']) {
        assert.throws(() => guard.checkUrl(u), (e) => ['address_refused', 'bad_url', 'port_refused'].includes(e.code), u);
    }
    guard.checkUrl('https://example.org/feed.xml');
});

t('boot a stub website on loopback', async () => {
    web = await site({
        '/robots.txt': () => ({ status: 404 }),
        '/feed.xml': () => ({ body: FEED }),
        '*': (req, res, ctx) => {
            const m = /^\/to\/(.+)$/.exec(ctx.url.pathname);
            return m ? { status: 302, headers: { Location: decodeURIComponent(m[1]) } } : { status: 404 };
        },
    });
    port = new URL(web.origin).port;
});

const strictBoot = (lookupImpl, allow = '') => boot({ env: { SOURCES_ALLOW_PRIVATE_HOSTS: allow, SOURCES_ALLOWED_PORTS: `80,443,${port}` }, lookupImpl });

t('endpoints spelled as internal addresses (with the stub\'s port) are refused and never reach it', async () => {
    const svc = await strictBoot();
    try {
        const n = web.requests.length;
        let i = 0;
        for (const host of ['127.0.0.1', '2130706433', '0177.0.0.1', '0x7f000001', '127.1', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[::1]', '0.0.0.0']) {
            const key = `spell-${i++}`;
            svc.registry.create(sourceDef({ key, endpoints: [`http://${host}:${port}/feed.xml`] }), 'test');
            const out = await svc.ingest.run(key, { trigger: 'manual' });
            assert.deepStrictEqual([out.runs[0].state, out.runs[0].error_code], ['http_error', 'address_refused'], host);
        }
        assert.strictEqual(web.requests.length, n, 'the internal service was reached');
    } finally { await svc.stop(); }
});

t('a name whose DNS answers include any internal address is refused where the connection is made', async () => {
    const table = {
        'mixed.example.com': [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }],
        'mapped.example.com': [{ address: '::ffff:127.0.0.1', family: 6 }],
        'nat64.example.com': [{ address: '64:ff9b::7f00:1', family: 6 }],
        'cgnat.example.com': [{ address: '100.64.0.1', family: 4 }],
        'meta.example.com': [{ address: '169.254.169.254', family: 4 }],
    };
    let lookups = 0;
    const lookupImpl = (host, opts, cb) => { lookups++; const a = table[String(host).toLowerCase()]; return a ? cb(null, a) : cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })); };
    const svc = await strictBoot(lookupImpl);
    try {
        const n = web.requests.length;
        for (const host of Object.keys(table)) {
            const key = `dns-${host.split('.')[0]}`;
            svc.registry.create(sourceDef({ key, endpoints: [`http://${host}:${port}/feed.xml`] }), 'test');
            const out = await svc.ingest.run(key, { trigger: 'manual' });
            assert.deepStrictEqual([out.runs[0].state, out.runs[0].error_code], ['http_error', 'address_refused'], host);
        }
        assert.ok(lookups >= Object.keys(table).length, 'the connection asked the guard\'s lookup');
        assert.strictEqual(web.requests.length, n);
    } finally { await svc.stop(); }
});

t('a redirect to any internal spelling is refused at that hop; the internal target is never hit', async () => {
    // hop.example.com is the one exempted name (it stands in for a public site; it resolves to the stub).
    const lookupImpl = (host, opts, cb) => (String(host).toLowerCase() === 'hop.example.com' ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })));
    const svc = await strictBoot(lookupImpl, 'hop.example.com');
    try {
        let i = 0;
        for (const to of [`http://127.0.0.1:${port}/feed.xml`, `http://2130706433:${port}/feed.xml`, `http://0x7f.1:${port}/feed.xml`, `http://[::ffff:7f00:1]:${port}/feed.xml`,
            `http://[::1]:${port}/feed.xml`, 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/admin', 'file:///etc/passwd', `gopher://127.0.0.1:${port}/_x`]) {
            const key = `redir-${i++}`;
            svc.registry.create(sourceDef({ key, endpoints: [`http://hop.example.com:${port}/to/${encodeURIComponent(to)}`] }), 'test');
            const before = web.hits('/feed.xml').length;
            const out = await svc.ingest.run(key, { trigger: 'manual' });
            assert.strictEqual(out.runs[0].state, 'http_error', `${to}: ${out.runs[0].state}`);
            assert.ok(['address_refused', 'bad_url', 'hop_refused', 'port_refused'].includes(out.runs[0].error_code), `${to}: ${out.runs[0].error_code}`);
            assert.strictEqual(web.hits('/feed.xml').length, before, `${to}: the target was fetched`);
        }
        assert.ok(web.requests.some((r) => r.path.startsWith('/to/')), 'the first hop was fetched (control)');
    } finally { await svc.stop(); }
});

t('a source registered over the API with internal endpoints is stored, and its fetch is refused', async () => {
    const svc = await strictBoot();
    try {
        const token = serviceToken('news', ['sources.*']);
        const def = sourceDef({ key: 'api-internal', endpoints: [`http://127.0.0.1:${port}/feed.xml`, 'http://169.254.169.254/latest/meta-data/'] });
        const created = await request(svc.base, 'POST', '/api/v1/sources', { token, body: def });
        assert.ok([200, 201, 400, 422].includes(created.status), created.text.slice(0, 200));
        if ([200, 201].includes(created.status)) {
            const n = web.requests.length;
            const r = await request(svc.base, 'POST', '/api/v1/sources/api-internal/fetch', { token, body: {} });
            assert.ok(r.status < 500, r.text.slice(0, 200));
            for (let i = 0; i < 20 && svc.db.prepare("SELECT COUNT(*) AS n FROM fetch_runs WHERE source_key = 'api-internal'").get().n < 2; i++) await new Promise((res) => setTimeout(res, 50));
            assert.strictEqual(web.requests.length, n, 'the internal endpoint was fetched');
        }
    } finally { await svc.stop(); }
});

t('ratchet: every file that makes an outbound request itself is reviewed', () => {
    const REVIEWED = {
        'server/net/fetcher.js': 'every source fetch; the guard (checkUrl up front, lookup at connect, on every redirect hop)',
        'server/auth.js': 'Network JWKS / token endpoint (configured)',
        'server/events/outbox.js': 'OpenVibe.Events (configured)',
    };
    const root = path.join(__dirname, '..');
    const found = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const f = path.join(dir, e.name);
            if (e.isDirectory()) walk(f);
            else if (e.name.endsWith('.js')) {
                const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
                if (/(^|[^.\w])(fetch|fetchImpl)\(|\bhttps?\.(get|request)\(|\bmod\.(get|request)\(|new WebSocket\(|require\(['"](axios|got|node-fetch|undici)['"]\)/m.test(src)) found.push(path.relative(root, f));
            }
        }
    };
    walk(path.join(root, 'server'));
    assert.deepStrictEqual(found.filter((f) => !REVIEWED[f]).sort(), [], 'a new outbound request site: route it through the guard, then add it here with the reason');
});

t('done', async () => { await web.close(); });

t.run();
