'use strict';
/**
 * retire_after_sec (sources.source@1, openvibe-contracts 0.211.0; plan 2026-10-22, track F2): a source of jobs or
 * listings retires what its feed stopped showing, so a consumer following the change feed learns the job is gone.
 *   - the registry takes an hour to a year, or null, and keeps it across a patch;
 *   - after a good run, an item not seen for that long is removed as gone_from_source (a change, an event);
 *   - an item seen within the window stays; a 304 counts as seeing again what the last good parse saw;
 *   - a failed run retires nothing, and a source without the setting keeps every item;
 *   - like any removal it is sticky: the item showing up again does not bring it back.
 */
const assert = require('assert');
const { boot, site, sourceDef, rss, suite } = require('./helpers');

const t = suite('retire');
const HOUR = 3600 * 1000;
let clock = Date.parse('2026-10-23T00:00:00Z');
let svc;
let web;
let listed;
let status;
let etag;

const feed = () => rss(listed.map((g) => ({ guid: g, title: `Job ${g}`, link: `https://jobs.example.org/${g}` })));
const run = async (key) => await svc.ingest.run(key, { trigger: 'manual' });
const itemsOf = async (key) => await svc.db.prepare('SELECT * FROM items WHERE source_key = ? ORDER BY identity').all(key);
const live = async (key) => (await itemsOf(key)).filter((i) => !i.removed_at).map((i) => i.identity);
const removedEvents = async (key) => (await svc.db.prepare('SELECT envelope FROM service_outbox ORDER BY id').all())
    .map((r) => r.envelope).filter((e) => e.event_type === 'sources.item.removed' && e.payload.source_key === key);
const show = (guids, tag) => { listed = guids; etag = tag; status = 200; };

t('boot', async () => {
    svc = await boot({ now: () => clock });
    web = await site({
        '/robots.txt': () => ({ status: 404 }),
        '/jobs.xml': (req) => {
            if (status !== 200) return { status, body: 'down' };
            if (etag && req.headers['if-none-match'] === etag) return { status: 304 };
            return { headers: { 'Content-Type': 'application/rss+xml', ETag: etag }, body: feed() };
        },
    });
});

t('the registry takes an hour to a year or null, and a patch keeps it', async () => {
    for (const bad of [3599, 365 * 86400 + 1, 1.5, '3600']) {
        await assert.rejects(svc.registry.create(sourceDef({ endpoints: [`${web.origin}/jobs.xml`], retire_after_sec: bad }), 'test'), /retire_after_sec/);
    }
    const plain = await svc.registry.create(sourceDef({ endpoints: [`${web.origin}/jobs.xml`] }), 'test');
    assert.strictEqual(svc.registry.view(plain).retire_after_sec, null);
    const row = await svc.registry.create(sourceDef({ key: 'jobs-a', category: 'jobs', endpoints: [`${web.origin}/jobs.xml`], retire_after_sec: 3600 }), 'test');
    assert.strictEqual(svc.registry.view(row).retire_after_sec, 3600);
    const patched = await svc.registry.patch('jobs-a', { name: 'Jobs A' }, 'test');
    assert.strictEqual(svc.registry.view(patched).retire_after_sec, 3600, 'a patch that does not name it keeps it');
});

t('an item the feed stopped showing is retired once unseen for the window, as gone_from_source', async () => {
    show(['a', 'b', 'c'], '"1"');
    assert.deepStrictEqual((await run('jobs-a')).runs.map((r) => r.state), ['ok']);
    assert.deepStrictEqual(await live('jobs-a'), ['a', 'b', 'c']);

    clock += 0.5 * HOUR;
    show(['a', 'c'], '"2"');
    await run('jobs-a');
    assert.deepStrictEqual(await live('jobs-a'), ['a', 'b', 'c'], 'b was seen half an hour ago: it stays');

    clock += 0.6 * HOUR;
    show(['a', 'c'], '"3"');
    await run('jobs-a');
    assert.deepStrictEqual(await live('jobs-a'), ['a', 'c']);
    const b = (await itemsOf('jobs-a')).find((i) => i.identity === 'b');
    assert.strictEqual(b.removed_reason, 'gone_from_source');
    const events = await removedEvents('jobs-a');
    assert.deepStrictEqual(events.map((e) => [e.payload.item_id, e.payload.reason]), [[b.id, 'gone_from_source']]);

    // The change feed carries it after everything before it, so a consumer following it removes the job.
    const page = await svc.items.list({ source: 'jobs-a', includeRemoved: true });
    const last = page.items[page.items.length - 1];
    assert.deepStrictEqual([last.id, last.removed && last.removed.reason], [b.id, 'gone_from_source']);
});

t('a 304 counts as seeing again what the last good parse saw', async () => {
    clock += 5 * HOUR;
    const out = await run('jobs-a');
    assert.deepStrictEqual(out.runs.map((r) => r.state), ['not_modified']);
    assert.deepStrictEqual(await live('jobs-a'), ['a', 'c'], 'the feed did not change: nothing is gone');
    for (const i of (await itemsOf('jobs-a')).filter((x) => !x.removed_at)) assert.strictEqual(Number(i.retrieved_at), clock);
});

t('a failed run retires nothing', async () => {
    clock += 5 * HOUR;
    status = 503;
    assert.deepStrictEqual((await run('jobs-a')).runs.map((r) => r.state), ['http_error']);
    assert.deepStrictEqual(await live('jobs-a'), ['a', 'c']);
});

t('retirement is sticky: the item showing up again stays removed', async () => {
    await svc.db.prepare('UPDATE sources SET last_request_at = NULL, not_before = 0 WHERE key = ?').run('jobs-a');
    show(['a', 'b', 'c'], '"4"');
    const [r] = (await run('jobs-a')).runs;
    assert.strictEqual(r.state, 'ok');
    assert.deepStrictEqual(await live('jobs-a'), ['a', 'c']);
    assert.strictEqual(r.items_skipped, 1);
});

t('a source without the setting keeps every item, however long ago it was seen', async () => {
    const row = await svc.registry.create(sourceDef({ key: 'news-keep', endpoints: [`${web.origin}/jobs.xml`] }), 'test');
    assert.strictEqual(svc.registry.view(row).retire_after_sec, null);
    show(['x', 'y'], '"5"');
    await run('news-keep');
    clock += 400 * 24 * HOUR;
    show(['x'], '"6"');
    await run('news-keep');
    assert.deepStrictEqual(await live('news-keep'), ['x', 'y']);
    assert.strictEqual((await removedEvents('news-keep')).length, 0);
});

t('close', async () => {
    await web.close();
    await svc.stop();
});

t.run();
