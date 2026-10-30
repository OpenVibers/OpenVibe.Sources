'use strict';
/**
 * The Hacker News "Who is hiring" resolver against recorded fixtures (no live call):
 *   - user/whoishiring.json → the newest matching story → its top-level kids only, never a reply's kids;
 *   - one job item per comment, the comment linked, the full text never stored;
 *   - the excerpt and title have emails and phones replaced;
 *   - every requested URL is a .json path, the API's robots rule.
 */
const assert = require('assert');
const { resolve, stripPrivate, htmlToText, assertJsonUrl } = require('../server/adapters/hn');
const { boot, fixture, site, sourceDef, suite } = require('./helpers');

const t = suite('hn-whoishiring');
const FILE = {
    'user/whoishiring.json': 'hn/user-whoishiring.json',
    'item/101.json': 'hn/story-101.json',
    'item/100.json': 'hn/story-100.json',
    'item/201.json': 'hn/item-201.json',
    'item/202.json': 'hn/item-202.json',
    'item/203.json': 'hn/item-203.json',
    'item/204.json': 'hn/item-204.json',
    'item/301.json': 'hn/item-301.json',
};

function recorded(extra = {}) {
    const asked = [];
    const getJson = async (url) => {
        asked.push(url);
        const key = String(url).replace('https://hacker-news.firebaseio.com/v0/', '');
        if (extra[key]) return extra[key];
        const name = FILE[key];
        if (!name) throw new Error(`the resolver asked for a fixture that does not exist: ${url}`);
        return JSON.parse(fixture(name));
    };
    return { asked, getJson };
}

const endpoint = { url: 'https://hacker-news.firebaseio.com/v0/user/whoishiring.json', max_bytes: 1048576 };

t('walks user → newest story → top-level kids; one job per comment, no reply tree', async () => {
    const { asked, getJson } = recorded();
    const out = await resolve({ endpoint, getJson, maxItems: 100, summaryMax: 1000 });
    assert.deepStrictEqual(out.items.map((i) => [i.identity, i.kind, i.canonical_url]), [
        ['hn-201', 'job', 'https://news.ycombinator.com/item?id=201'],
        ['hn-203', 'job', 'https://news.ycombinator.com/item?id=203'],
    ], 'the deleted and dead comments are not job posts');
    assert.strictEqual(out.skipped, 2);
    assert.deepStrictEqual(asked, [
        'https://hacker-news.firebaseio.com/v0/user/whoishiring.json',
        'https://hacker-news.firebaseio.com/v0/item/101.json',
        'https://hacker-news.firebaseio.com/v0/item/201.json',
        'https://hacker-news.firebaseio.com/v0/item/202.json',
        'https://hacker-news.firebaseio.com/v0/item/203.json',
        'https://hacker-news.firebaseio.com/v0/item/204.json',
    ], 'the newest story is the October one; reply 301 and older story 100 are never fetched');
    assert.ok(asked.every((u) => new URL(u).pathname.endsWith('.json')), 'every request is a .json path');
    const a = out.items[0];
    assert.strictEqual(a.title, 'Acme Corp | Senior Backend Engineer | Remote (US)');
    assert.deepStrictEqual(a.authors, ['acme_founder']);
    assert.strictEqual(a.published_at, new Date(1793603600 * 1000).toISOString());
    assert.deepStrictEqual(a.fields, {
        story_id: '101',
        story_title: 'Ask HN: Who is hiring? (October 2026)',
        story_url: 'https://news.ycombinator.com/item?id=101',
    });
    assert.ok(!('text' in a) && !('html' in a), 'the full comment is not stored');
});

t('privacy: the excerpt and title carry [email] and [phone], never the address itself', async () => {
    const { getJson } = recorded();
    const out = await resolve({ endpoint, getJson, maxItems: 100, summaryMax: 1000 });
    const [acme, beta] = out.items;
    assert.ok(acme.summary.includes('[email]') && acme.summary.includes('[phone]'), acme.summary);
    assert.ok(!acme.summary.includes('jobs@acme.example') && !acme.summary.includes('555-0123'), acme.summary);
    assert.ok(beta.summary.includes('[email]') && beta.summary.includes('[phone]'), beta.summary);
    assert.ok(!beta.summary.includes('beta@example.org') && !beta.summary.includes('555-0199'), beta.summary);
    assert.ok(beta.title.includes('Beta & Co'), 'the HTML entity is text again');
    assert.ok(!JSON.stringify(out.items).includes('@acme.example'));
    assert.strictEqual(stripPrivate('mail me at a.b+tag@example.co.uk or call +44 20 7946 0958'), 'mail me at [email] or call [phone]');
    assert.strictEqual(htmlToText('one<p>two &amp; three<br>four &#x27;five&#x27;'), "one\ntwo & three\nfour 'five'");
});

t('the .json rule and a thread with no Who is hiring story are refused', async () => {
    assert.throws(() => assertJsonUrl('https://hacker-news.firebaseio.com/v0/item/1.html'), /only \.json/);
    const { getJson } = recorded({
        'user/whoishiring.json': { id: 'whoishiring', submitted: [999] },
        'item/999.json': { id: 999, type: 'story', title: 'Ask HN: Who wants to be hired? (October 2026)', kids: [] },
    });
    await assert.rejects(
        () => resolve({ endpoint, getJson, maxItems: 10, summaryMax: 1000 }),
        (err) => err.code === 'parse_error' && /no "Ask HN: Who is hiring\?" story/.test(err.message),
    );
});

t('the row limit stops at maxItems without fetching the rest', async () => {
    const { asked, getJson } = recorded();
    const out = await resolve({ endpoint, getJson, maxItems: 1, summaryMax: 1000 });
    assert.strictEqual(out.items.length, 1);
    assert.deepStrictEqual(asked.filter((u) => u.includes('/item/')), [
        'https://hacker-news.firebaseio.com/v0/item/101.json',
        'https://hacker-news.firebaseio.com/v0/item/201.json',
    ]);
});

t('ingest: the resolver branch stores the jobs, links the comments and records its own parser version', async () => {
    const svc = await boot();
    const byPath = {
        '/v0/user/whoishiring.json': 'hn/user-whoishiring.json',
        '/v0/item/101.json': 'hn/story-101.json',
        '/v0/item/201.json': 'hn/item-201.json',
        '/v0/item/202.json': 'hn/item-202.json',
        '/v0/item/203.json': 'hn/item-203.json',
        '/v0/item/204.json': 'hn/item-204.json',
    };
    const web = await site({
        '/robots.txt': () => ({ body: 'User-agent: *\nAllow: /*.json$\nAllow: /*.json?*$\nDisallow: /\n' }),
        '*': (req, res, ctx) => {
            const name = byPath[ctx.url.pathname];
            if (!name) return { status: 404, body: 'no fixture' };
            return { headers: { 'Content-Type': 'application/json' }, body: fixture(name) };
        },
    });
    try {
        await svc.registry.create(sourceDef({
            key: 'hn-ingest', type: 'api', category: 'jobs', enabled: true, max_items: 100,
            endpoints: [{ url: `${web.origin}/v0/user/whoishiring.json`, format: 'json', resolver: 'hn-whoishiring', item_kind: 'job', max_bytes: 1048576, timeout_ms: 10000 }],
        }), 'test');
        const out = await svc.ingest.run('hn-ingest');
        assert.deepStrictEqual([out.runs[0].state, out.runs[0].parser_version, out.runs[0].items_seen], ['ok', 'hn-whoishiring@1', 2]);
        const rows = await svc.db.prepare('SELECT identity, kind, canonical_url, summary, parser_version FROM items WHERE source_key = ? ORDER BY identity').all('hn-ingest');
        assert.deepStrictEqual(rows.map((r) => [r.identity, r.kind, r.canonical_url]), [
            ['hn-201', 'job', 'https://news.ycombinator.com/item?id=201'],
            ['hn-203', 'job', 'https://news.ycombinator.com/item?id=203'],
        ]);
        assert.ok(rows.every((r) => r.parser_version === 'hn-whoishiring@1'));
        assert.ok(!rows.some((r) => /jobs@acme\.example|555-0123|beta@example\.org/.test(r.summary)), 'no email or phone reached the database');
    } finally { await svc.stop(); await web.close(); }
});

t.run();
