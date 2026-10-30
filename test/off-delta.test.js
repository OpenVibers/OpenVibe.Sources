'use strict';
/**
 * Open Food Facts' official delta index (server/adapters/off-delta.js, the ingest off-delta branch):
 *   - the index's parts are read oldest first;
 *   - a run reads up to max_rows across parts and stops inside one, keeping its row offset;
 *   - the next run skips those rows, finishes the part, and continues to the next one;
 *   - a new part appearing at the top of the index is picked up next;
 *   - the full export is never requested.
 * Both the index and the delta files are recorded fixtures (gzipped in the stub); no live call here.
 */
const assert = require('assert');
const zlib = require('zlib');
const { boot, fixture, site, sourceDef, suite } = require('./helpers');
const { parseIndex, readState, nextFiles } = require('../server/adapters/off-delta');

const t = suite('off-delta');

const NAMES = [
    'openfoodfacts_products_1793000000_1793100000.json.gz',
    'openfoodfacts_products_1793100000_1793200000.json.gz',
    'openfoodfacts_products_1793200000_1793300000.json.gz',
];
const NEWEST = 'openfoodfacts_products_1793300000_1793400000.json.gz';
const BODY = {
    [NAMES[0]]: 'off/delta-1.jsonl',
    [NAMES[1]]: 'off/delta-2.jsonl',
    [NAMES[2]]: 'off/delta-3.jsonl',
    [NEWEST]: 'off/delta-4.jsonl',
};
const indexBody = (names = NAMES) => names.join('\n') + '\n';

t('the index parses oldest first, refuses a path or a name with no time range, and a cursor resumes a part', () => {
    const files = parseIndex(fixture('off/delta-index.txt'), 'https://static.example.org/data/delta/index.txt');
    assert.deepStrictEqual(files.map((f) => f.name), NAMES, 'oldest first, though the recorded index lists newest first');
    assert.deepStrictEqual([files[0].start, files[0].end, files[0].url], [1793000000, 1793100000, `https://static.example.org/data/delta/${NAMES[0]}`]);
    assert.throws(() => parseIndex('../evil_1793000000_1793100000.json.gz', 'https://x.example/data/delta/index.txt'), /unexpected file/);
    assert.throws(() => parseIndex('openfoodfacts_products.json.gz', 'https://x.example/data/delta/index.txt'), /no start\/end/);
    assert.throws(() => parseIndex('', 'https://x.example/data/delta/index.txt'), /lists no files/);
    const state = readState(JSON.stringify({ seen: NAMES[0], seen_end: 1793100000, current: NAMES[1], offset: 1 }));
    assert.deepStrictEqual(nextFiles(files, state).map((f) => f.name), [NAMES[1], NAMES[2]]);
    assert.deepStrictEqual(readState('not json'), { seen: null, seen_end: 0, current: null, offset: 0 });
});

t('the first run reads old parts up to the limit and keeps the part and row offset; later runs continue', async () => {
    const svc = await boot();
    let index = indexBody([...NAMES].reverse());
    const web = await site({
        '/robots.txt': () => ({ body: 'User-agent: *\nAllow: /\n' }),
        '/data/delta/index.txt': () => ({ headers: { 'Content-Type': 'text/plain' }, body: index }),
        '*': (req, res, ctx) => {
            const name = ctx.url.pathname.split('/').pop();
            const file = BODY[name];
            if (!file || !ctx.url.pathname.startsWith('/data/delta/')) return { status: 404, body: 'no such delta' };
            return { headers: { 'Content-Type': 'application/octet-stream' }, body: zlib.gzipSync(fixture(file)) };
        },
    });
    const stateOf = async () => JSON.parse((await svc.db.prepare('SELECT value FROM source_state WHERE source_key = ? AND name = ?').get('off-delta-test', 'delta.cursor')).value);
    const count = async () => (await svc.db.prepare('SELECT COUNT(*) AS n FROM items WHERE source_key = ?').get('off-delta-test')).n;
    try {
        await svc.registry.create(sourceDef({
            key: 'off-delta-test', type: 'bulk', category: 'food', enabled: true, max_items: 100,
            endpoints: [{
                url: `${web.origin}/data/delta/index.txt`, format: 'jsonl', resolver: 'off-delta', item_kind: 'food_product',
                max_bytes: 1048576, max_rows: 3, timeout_ms: 10000,
                fields: { identity: 'code', title: 'product_name' },
                extra: {
                    brands: 'brands', nutriscore_grade: 'nutriscore_grade',
                    energy_kcal_100g: 'nutrition.aggregated_set.nutrients.energy-kcal.value',
                    proteins_100g: 'nutrition.aggregated_set.nutrients.proteins.value',
                },
            }],
        }), 'test');

        const first = await svc.ingest.run('off-delta-test');
        assert.deepStrictEqual([first.runs[0].state, first.runs[0].items_seen], ['ok', 3]);
        assert.deepStrictEqual((await stateOf()), { seen: NAMES[0], seen_end: 1793100000, current: NAMES[1], offset: 1 });
        assert.strictEqual(await count(), 3);
        assert.strictEqual(web.hits(`/data/delta/${NAMES[0]}`).length, 1);
        assert.strictEqual(web.hits(`/data/delta/${NAMES[1]}`).length, 1);
        assert.strictEqual(web.hits(`/data/delta/${NAMES[2]}`).length, 0, 'the limit stopped before the third part');
        assert.ok(!web.requests.some((r) => /products\.csv|products\.jsonl/.test(r.path)), 'the full export is never requested');
        const eggs = JSON.parse((await svc.db.prepare('SELECT fields FROM items WHERE source_key = ? AND identity = ?').get('off-delta-test', '0000000000011')).fields);
        assert.deepStrictEqual([eggs.brands, eggs.nutriscore_grade, eggs.energy_kcal_100g, eggs.proteins_100g], ['Example Brand', 'b', 143, 12.6]);

        const second = await svc.ingest.run('off-delta-test');
        assert.deepStrictEqual([second.runs[0].state, second.runs[0].items_seen], ['ok', 2]);
        assert.deepStrictEqual((await stateOf()), { seen: NAMES[2], seen_end: 1793300000, current: null, offset: 0 });
        assert.strictEqual(await count(), 5);
        assert.strictEqual(web.hits(`/data/delta/${NAMES[1]}`).length, 2, 'the unfinished part is streamed again to skip its first row');
        assert.strictEqual(web.hits(`/data/delta/${NAMES[2]}`).length, 1);

        const third = await svc.ingest.run('off-delta-test');
        assert.deepStrictEqual([third.runs[0].state, third.runs[0].items_seen], ['ok', 0]);
        assert.strictEqual(web.hits(`/data/delta/${NAMES[2]}`).length, 1, 'nothing re-read when no part is new');

        index = indexBody([NEWEST, ...NAMES]);
        const fourth = await svc.ingest.run('off-delta-test');
        assert.deepStrictEqual([fourth.runs[0].state, fourth.runs[0].items_seen], ['ok', 1]);
        assert.strictEqual(await count(), 6);
        assert.deepStrictEqual((await stateOf()), { seen: NEWEST, seen_end: 1793400000, current: null, offset: 0 });
    } finally { await svc.stop(); await web.close(); }
});

t.run();
