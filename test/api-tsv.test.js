'use strict';
/** API adapter: `format: "tsv"` reads a tab-separated file by its header, and `duplicates: "last"` keeps a series' newest row. */
const assert = require('assert');
const api = require('../server/adapters/api');
const { suite } = require('./helpers');

const t = suite('api-tsv');

// download.bls.gov/pub/time.series/ap/ap.data.0.Current as BLS writes it: padded names and values, CRLF, an empty
// last column, every series oldest to newest.
const BLS = [
    'series_id        \tyear\tperiod\t       value\tfootnote_codes',
    'APU0000708111    \t2026\tM07\t       2.301\t',
    'APU0000708111    \t2026\tM08\t       2.272\t',
    'APU0000708111    \t2026\tM09\t       2.272\t',
    'APU0000709112    \t2026\tM08\t       4.016\t',
    'APU0000709112    \t2026\tM09\t       4.051\t',
    'APU0000711211    \t2026\tM09\t       0.633\t',
    'APU0000799999    \t2026\tM09\t       9.999\t',
    'a broken line without tabs',
    '',
].join('\r\n');

const blsEndpoint = {
    format: 'tsv', items_path: '', item_kind: 'price', duplicates: 'last',
    where: { series_id: ['APU0000708111', 'APU0000709112', 'APU0000711211'] },
    fields: { identity: 'series_id', title: 'series_id' },
    extra: { value: 'value', year: 'year', period: 'period' },
};

t('a BLS series file: one item per wanted series with its newest value; others filtered, broken lines skipped', () => {
    assert.strictEqual(api.checkMapping(blsEndpoint), null);
    const r = api.parse(BLS, { url: 'https://download.bls.gov/pub/time.series/ap/ap.data.0.Current', endpoint: blsEndpoint });
    assert.strictEqual(r.meta.format, 'tsv');
    assert.deepStrictEqual(r.items.map((i) => [i.identity, i.fields.value, i.fields.period]), [
        ['APU0000708111', '2.272', 'M09'],
        ['APU0000709112', '4.051', 'M09'],
        ['APU0000711211', '0.633', 'M09'],
    ], 'the newest row of each, in first-seen order; values trimmed');
    assert.strictEqual(r.items[0].kind, 'price');
    assert.strictEqual(r.items[0].fields.year, '2026');
    assert.strictEqual(r.meta.filtered, 1, 'the series nobody asked for');
    assert.strictEqual(r.skipped, 4, 'the broken line and the three older rows replaced');
});

t('duplicates default to the first; maxItems counts distinct identities', () => {
    const first = api.parse(BLS, { url: 'https://download.bls.gov/x', endpoint: { ...blsEndpoint, duplicates: undefined } });
    assert.strictEqual(first.items[0].fields.value, '2.301', 'the first row stays');
    const capped = api.parse(BLS, { url: 'https://download.bls.gov/x', endpoint: blsEndpoint, maxItems: 2 });
    assert.deepStrictEqual(capped.items.map((i) => [i.identity, i.fields.period]), [['APU0000708111', 'M09'], ['APU0000709112', 'M09']], 'a repeat of a kept series still replaces it at the cap');
});

t('filter: the BLS CPI rent seed keeps one series\' rows, one item per month, by record position', () => {
    const rent = {
        format: 'tsv', items_path: '', item_kind: 'rent_cpi',
        filter: { series_id: 'APU0000708111' },
        fields: { identity: '$index', title: 'series_id' },
        extra: { value: 'value', year: 'year', period: 'period' },
    };
    assert.strictEqual(api.checkMapping(rent), null);
    const r = api.parse(BLS, { url: 'https://download.bls.gov/x', endpoint: rent });
    assert.deepStrictEqual(r.items.map((i) => [i.identity, i.fields.value, i.fields.period]), [
        ['0', '2.301', 'M07'], ['1', '2.272', 'M08'], ['2', '2.272', 'M09'],
    ], 'only the series asked for; $index is the row\'s position in the whole file');
    assert.strictEqual(r.meta.filtered, 4, 'the other series rows are filtered');
    assert.strictEqual(r.skipped, 1, 'the malformed line');
    // A filter and a where may both be given: every condition applies.
    const both = api.parse(BLS, { url: 'https://download.bls.gov/x', endpoint: { ...rent, where: { year: '2026' } } });
    assert.strictEqual(both.items.length, 3);
    const none = api.parse(BLS, { url: 'https://download.bls.gov/x', endpoint: { ...rent, filter: { series_id: 'APU0000709999' } } });
    assert.deepStrictEqual([none.items.length, none.meta.filtered], [0, 7]);
    assert.match(api.checkMapping({ ...rent, filter: 'series_id' }), /filter must be an object/);
    assert.match(api.checkMapping({ ...rent, filter: { 'bad path!': 'x' } }), /filter\.bad path! path is malformed/);
});

t('mapping and body errors', () => {
    assert.match(api.checkMapping({ ...blsEndpoint, format: 'csv' }), /format must be json, xml or tsv/);
    assert.match(api.checkMapping({ ...blsEndpoint, items_path: 'rows' }), /items_path is ""/);
    assert.match(api.checkMapping({ ...blsEndpoint, duplicates: 'newest' }), /duplicates must be first or last/);
    assert.throws(() => api.parse('', { url: 'https://x.example/', endpoint: blsEndpoint }), /no header line/);
    assert.throws(() => api.parse('a\t\tb\n1\t2\t3', { url: 'https://x.example/', endpoint: blsEndpoint }), /header names must be present and distinct/);
    // JSON endpoints are unchanged: a duplicate identity still keeps the first.
    const json = api.parse(JSON.stringify([{ id: 'a', v: 1 }, { id: 'a', v: 2 }]), { url: 'https://x.example/', endpoint: { fields: { identity: 'id' }, extra: { v: 'v' } } });
    assert.deepStrictEqual([json.items.length, json.items[0].fields.v, json.skipped], [1, 1, 1]);
});

t.run();
