'use strict';
/** robots.txt is respected (rules, unreachable = deny, redirects) and internal addresses are never fetched. */
const assert = require('assert');
const { parseRobots, isAllowed } = require('../server/robots');
const { isPublicAddress } = require('../server/net/guard');
const { boot, site, sourceDef, rss, suite } = require('./helpers');

const t = suite('robots-ssrf');
const FEED = rss([{ guid: 'x', title: 'X', link: 'https://example.org/x' }]);

t('robots rules: our group over *, longest match, Allow wins ties, * and $', () => {
    const txt = [
        'User-agent: *', 'Disallow: /', '',
        'User-agent: OpenVibeSources', 'User-agent: other-bot', 'Disallow: /private', 'Allow: /private/press', 'Disallow: /*.pdf$', 'Crawl-delay: 2', '',
        'User-agent: openvibesources', 'Disallow: /tmp/',
    ].join('\n');
    const p = parseRobots(txt, 'OpenVibeSources');
    assert.strictEqual(p.crawlDelaySec, 2);
    assert.strictEqual(isAllowed(p, '/'), true, 'the * group does not apply when ours exists');
    assert.strictEqual(isAllowed(p, '/private/x'), false);
    assert.strictEqual(isAllowed(p, '/private/press/2026'), true);
    assert.strictEqual(isAllowed(p, '/docs/a.pdf'), false);
    assert.strictEqual(isAllowed(p, '/docs/a.pdf?x=1'), true);
    assert.strictEqual(isAllowed(p, '/tmp/file'), false, 'groups for the same agent merge');
    const star = parseRobots('User-agent: *\nDisallow: /a\nAllow: /a\n', 'OpenVibeSources');
    assert.strictEqual(isAllowed(star, '/a/b'), true, 'Allow wins a tie');
    const empty = parseRobots('User-agent: *\nDisallow:\n', 'OpenVibeSources');
    assert.strictEqual(isAllowed(empty, '/anything'), true);
    const prefix = parseRobots('User-agent: OpenVibe\nDisallow: /\n', 'OpenVibeSources');
    assert.strictEqual(isAllowed(prefix, '/x'), true, 'a different token (even a prefix of ours) does not apply');
});

t('address policy', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::a00:1', '2002:c0a8:101::1', '224.0.0.1']) {
        assert.strictEqual(isPublicAddress(ip), false, ip);
    }
    for (const ip of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111']) assert.strictEqual(isPublicAddress(ip), true, ip);
});

let svc;
let web;

t('boot', async () => {
    svc = await boot();
    web = await site({
        '/robots.txt': () => ({ body: 'User-agent: *\nDisallow: /private/\n' }),
        '/private/feed.xml': () => ({ body: FEED }),
        '/public/feed.xml': () => ({ body: FEED }),
        '/public/moved': () => ({ status: 301, headers: { Location: '/private/feed.xml' } }),
    });
});

t('a disallowed endpoint is robots_denied and never requested', async () => {
    svc.registry.create(sourceDef({ key: 'denied', endpoints: [`${web.origin}/private/feed.xml`, `${web.origin}/public/feed.xml`] }), 'test');
    const out = await svc.ingest.run('denied', { trigger: 'manual' });
    assert.deepStrictEqual(out.runs.map(r => r.state), ['robots_denied', 'ok']);
    assert.strictEqual(web.hits('/private/feed.xml').length, 0);
    assert.strictEqual(web.hits('/robots.txt').length, 1, 'robots.txt is cached per origin');
    assert.ok(svc.outbox.all().some(e => e.event_type === 'sources.fetch.failed' && e.payload.state === 'robots_denied'));
});

t('a redirect into a disallowed path is refused before it is followed', async () => {
    svc.registry.create(sourceDef({ key: 'hop', endpoints: [`${web.origin}/public/moved`] }), 'test');
    const out = await svc.ingest.run('hop', { trigger: 'manual' });
    assert.deepStrictEqual([out.runs[0].state, out.runs[0].error_code], ['robots_denied', 'hop_refused']);
    assert.strictEqual(web.hits('/private/feed.xml').length, 0);
});

t('robots.txt 5xx or unreachable means complete disallow; 404 means allowed', async () => {
    const down = await site({ '/robots.txt': () => ({ status: 503 }), '/feed.xml': () => ({ body: FEED }) });
    const none = await site({ '/robots.txt': () => ({ status: 404 }), '/feed.xml': () => ({ body: FEED }) });
    try {
        svc.registry.create(sourceDef({ key: 'robots-down', endpoints: [`${down.origin}/feed.xml`] }), 'test');
        svc.registry.create(sourceDef({ key: 'robots-none', endpoints: [`${none.origin}/feed.xml`] }), 'test');
        assert.strictEqual((await svc.ingest.run('robots-down', { trigger: 'manual' })).runs[0].state, 'robots_denied');
        assert.strictEqual(down.hits('/feed.xml').length, 0);
        assert.strictEqual((await svc.ingest.run('robots-none', { trigger: 'manual' })).runs[0].state, 'ok');
    } finally { await down.close(); await none.close(); }
});

t('Crawl-delay spaces requests to the host', async () => {
    const s = await site({ '/robots.txt': () => ({ body: 'User-agent: *\nCrawl-delay: 1\n' }), '/a': () => ({ body: FEED }), '/b': () => ({ body: FEED }) });
    try {
        svc.registry.create(sourceDef({ key: 'crawl-delay', endpoints: [`${s.origin}/a`, `${s.origin}/b`] }), 'test');
        await svc.ingest.run('crawl-delay', { trigger: 'manual' });
        const gap = s.hits('/b')[0].at - s.hits('/a')[0].at;
        assert.ok(gap >= 950, `gap ${gap} ms`);
    } finally { await s.close(); }
});

t('loopback and private addresses are refused unless explicitly allowlisted', async () => {
    const strict = await boot({ env: { SOURCES_ALLOW_PRIVATE_HOSTS: '' } });
    try {
        strict.registry.create(sourceDef({ key: 'loop', endpoints: [`${web.origin}/public/feed.xml`] }), 'test');
        const out = await strict.ingest.run('loop', { trigger: 'manual' });
        assert.strictEqual(out.runs[0].state, 'http_error');
        assert.ok(['address_refused', 'port_refused'].includes(out.runs[0].error_code), out.runs[0].error_code);
        const n = web.requests.length;
        strict.registry.create(sourceDef({ key: 'meta', endpoints: ['http://169.254.169.254/latest/meta-data/'] }), 'test');
        const meta = await strict.ingest.run('meta', { trigger: 'manual' });
        assert.deepStrictEqual([meta.runs[0].state, meta.runs[0].error_code], ['http_error', 'address_refused']);
        assert.strictEqual(web.requests.length, n);
    } finally { await strict.stop(); }
});

t('a public-looking name that resolves to a private address is refused at connect time', async () => {
    // DNS stub: "feeds.example.com" resolves to 127.0.0.1 (a rebinding-style answer)
    const lookupImpl = (host, opts, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]);
    const strict = await boot({ env: { SOURCES_ALLOW_PRIVATE_HOSTS: '', SOURCES_ALLOWED_PORTS: `80,443,${new URL(web.origin).port}` }, lookupImpl });
    try {
        const port = new URL(web.origin).port;
        strict.registry.create(sourceDef({ key: 'rebind', endpoints: [`http://feeds.example.com:${port}/public/feed.xml`] }), 'test');
        const n = web.requests.length;
        const out = await strict.ingest.run('rebind', { trigger: 'manual' });
        assert.deepStrictEqual([out.runs[0].state, out.runs[0].error_code], ['http_error', 'address_refused']);
        assert.strictEqual(web.requests.length, n, 'no connection was made');
        assert.strictEqual(strict.db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 0);
    } finally { await strict.stop(); }
});

t('redirects to an internal address are refused', async () => {
    const s = await site({ '/robots.txt': () => ({ status: 404 }), '/r': () => ({ status: 302, headers: { Location: 'http://10.0.0.5/admin' } }) });
    try {
        svc.registry.create(sourceDef({ key: 'redir-internal', endpoints: [`${s.origin}/r`] }), 'test');
        const out = await svc.ingest.run('redir-internal', { trigger: 'manual' });
        assert.deepStrictEqual([out.runs[0].state, out.runs[0].error_code], ['http_error', 'address_refused']);
    } finally { await s.close(); }
});

t('done', async () => { await web.close(); await svc.stop(); });

t.run();
