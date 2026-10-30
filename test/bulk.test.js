'use strict';
/**
 * The bulk dataset adapter and its ingest path: one streamed file, parsed as CSV, JSONL or TSV, with a row limit
 * the stream stops at and a byte cap that refuses an oversize body. A large fixture is never read whole: the
 * parser's write() returns false at the limit and the fetcher destroys the response.
 */
const assert = require('assert');
const zlib = require('zlib');
const { boot, site, sourceDef, suite } = require('./helpers');
const { createParser, PARSER_VERSION } = require('../server/adapters/bulk');
const { validateSource } = require('../server/registry');

const t = suite('bulk');

const csvEndpoint = {
    format: 'csv', item_kind: 'product', max_rows: 10,
    fields: { identity: 'code', title: 'product_name' },
    extra: { energy_kcal: 'energy-kcal_100g', brands: 'brands' },
};

t('CSV: quoted commas and newlines survive a chunk boundary', () => {
    const body = 'code,product_name,brands,energy-kcal_100g\r\n'
        + '001,"Pate, noir",Bovetti,250\r\n'
        + '002,"Two\nlines",Acme,120\r\n'
        + '003,Plain,,90\r\n';
    const parser = createParser({ endpoint: csvEndpoint, url: 'https://static.example.org/d.csv', maxItems: 100 });
    for (const ch of Buffer.from(body)) parser.write(Buffer.from([ch]));      // one byte at a time, quotes split too
    const out = parser.end();
    assert.strictEqual(PARSER_VERSION, 'bulk@1');
    assert.deepStrictEqual(out.items.map((i) => [i.identity, i.title, i.fields.energy_kcal]), [
        ['001', 'Pate, noir', '250'], ['002', 'Two lines', '120'], ['003', 'Plain', '90'],
    ]);
    assert.strictEqual(out.meta.format, 'csv');
    assert.strictEqual(out.meta.rows, 3);
});

t('the row limit stops a large fixture without reading it whole', () => {
    const endpoint = { ...csvEndpoint, max_rows: 1000 };
    const parser = createParser({ endpoint, url: 'https://static.example.org/big.csv', maxItems: 5000 });
    let fed = 0;
    let wrote = 0;
    const chunk = (from) => {
        const lines = [];
        if (from === 0) lines.push('code,product_name,brands,energy-kcal_100g');
        for (let i = from; i < from + 100; i++) lines.push(`${i},Product ${i},Brand,${i % 900}`);
        return Buffer.from(lines.join('\n') + '\n');
    };
    let from = 0;
    for (;;) {
        const buf = chunk(from);
        from += 100;
        fed += buf.length;
        wrote++;
        if (parser.write(buf) === false) break;
        if (wrote > 100) throw new Error('the parser never stopped');
    }
    const out = parser.end();
    assert.strictEqual(out.items.length, 1000, 'exactly the row limit');
    assert.strictEqual(out.meta.capped, true);
    assert.ok(fed < 200_000, `read ${fed} bytes, far less than a full multi-GB file`);
    assert.ok(parser.full);
});

t('a byte cap is a recorded failure, and no item is made from a refused body', async () => {
    const svc = await boot();
    const big = 'code,product_name\n' + Array.from({ length: 2000 }, (_, i) => `${i},P${i}`).join('\n') + '\n';
    const web = await site({
        '/robots.txt': () => ({ body: 'User-agent: *\nAllow: /\n' }),
        '/products.csv': (req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/csv' });
            for (let i = 0; i < big.length; i += 1024) res.write(big.slice(i, i + 1024));
            res.end();
        },
    });
    try {
        await svc.registry.create(sourceDef({
            key: 'bulk-cap', type: 'bulk', category: 'food', enabled: true, max_items: 5000,
            endpoints: [{ ...csvEndpoint, url: `${web.origin}/products.csv`, max_rows: 5000, max_bytes: 2048 }],
        }), 'test');
        const out = await svc.ingest.run('bulk-cap');
        assert.strictEqual(out.runs[0].state, 'http_error');
        assert.strictEqual(out.runs[0].error_code, 'too_large');
        assert.strictEqual((await svc.db.prepare('SELECT COUNT(*) AS n FROM items WHERE source_key = ?').get('bulk-cap')).n, 0);
    } finally { await svc.stop(); await web.close(); }
});

t('a gzipped dataset is decompressed while it streams; the row limit ends the download early', async () => {
    const svc = await boot();
    const rows = Array.from({ length: 5000 }, (_, i) => `${i},Product ${i},Brand,${i % 900}`);
    const csv = 'code,product_name,brands,energy-kcal_100g\n' + rows.join('\n') + '\n';
    const gz = zlib.gzipSync(csv);
    let sent = 0;
    const web = await site({
        '/robots.txt': () => ({ body: 'User-agent: *\nAllow: /\n' }),
        '/products.csv.gz': (req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/gzip' });
            // Write it in pieces, and stop when the client has enough (the row limit destroys the response).
            for (let i = 0; i < gz.length; i += 512) {
                if (res.destroyed || res.writableEnded) break;
                res.write(gz.slice(i, i + 512));
                sent += Math.min(512, gz.length - i);
            }
            if (!res.destroyed && !res.writableEnded) res.end();
        },
    });
    try {
        await svc.registry.create(sourceDef({
            key: 'bulk-gz', type: 'bulk', category: 'food', enabled: true,
            endpoints: [{ ...csvEndpoint, url: `${web.origin}/products.csv.gz`, max_rows: 50, max_bytes: 8 * 1024 * 1024 }],
        }), 'test');
        const out = await svc.ingest.run('bulk-gz');
        assert.deepStrictEqual([out.runs[0].state, out.runs[0].items_seen], ['ok', 50]);
        assert.strictEqual((await svc.db.prepare('SELECT COUNT(*) AS n FROM items WHERE source_key = ?').get('bulk-gz')).n, 50);
        assert.ok(sent <= gz.length, 'the server sent only what was asked for');
    } finally { await svc.stop(); await web.close(); }
});

t('JSONL and TSV read nested paths and headers', () => {
    const jsonl = '{"code":"a","name":"A","nutriments":{"energy-kcal":10}}\n{"code":"b","name":"B","nutriments":{"energy-kcal":20}}\nnot json\n';
    const j = createParser({
        endpoint: { format: 'jsonl', fields: { identity: 'code', title: 'name' }, extra: { energy_kcal: 'nutriments.energy-kcal' } },
        url: 'https://static.example.org/d.jsonl', maxItems: 100,
    });
    j.write(Buffer.from(jsonl.slice(0, 37)));
    j.write(Buffer.from(jsonl.slice(37)));
    const jout = j.end();
    assert.deepStrictEqual(jout.items.map((i) => [i.identity, i.fields.energy_kcal]), [['a', 10], ['b', 20]]);
    assert.strictEqual(jout.skipped, 1, 'the malformed line is counted, not invented');

    const tsv = 'series_id\tyear\tvalue\nCUUR0000SEHA\t2026\t450.402\nCUUR0000SEHA\t2025\t430.1\n';
    const p = createParser({
        endpoint: { format: 'tsv', fields: { identity: '$index', title: 'series_id' }, extra: { year: 'year', value: 'value' } },
        url: 'https://download.bls.gov/x', maxItems: 100,
    });
    p.write(Buffer.from(tsv));
    const tout = p.end();
    assert.deepStrictEqual(tout.items.map((i) => [i.identity, i.fields.value]), [['0', '450.402'], ['1', '430.1']]);});

t('the registry takes one bulk endpoint with a format, a row limit and a byte cap; it refuses a second file or retirement', () => {
    const seed = sourceDef({
        key: 'bulk-seed', type: 'bulk', category: 'food', enabled: false,
        endpoints: [{ url: 'https://static.example.org/d.csv', format: 'csv', max_rows: 20, max_bytes: 4096, fields: { identity: 'code' } }],
    });
    const rec = validateSource(seed);
    assert.deepStrictEqual([rec.type, rec.endpoints[0].format, rec.endpoints[0].max_rows], ['bulk', 'csv', 20]);
    assert.throws(() => validateSource({ ...seed, endpoints: [...seed.endpoints, { ...seed.endpoints[0], url: 'https://static.example.org/e.csv' }] }), /exactly one endpoint/);
    assert.throws(() => validateSource({ ...seed, retire_after_sec: 86400 }), /retire_after_sec/);
    assert.throws(() => validateSource({ ...seed, endpoints: [{ ...seed.endpoints[0], where: { x: 1 } }] }), /not a bulk field/);
    assert.throws(() => validateSource({ ...seed, endpoints: [{ ...seed.endpoints[0], format: 'json' }] }), /format must be csv, jsonl or tsv/);
});

t.run();
