'use strict';
/**
 * The USDA ERS fruit and vegetable prices source, end to end at the adapter: its seed's two endpoint mappings read the
 * two CSVs ERS published on 2026-11-06 (recorded byte-for-byte in test/fixtures/), one item per product and form.
 * This is the source Food's 16 mapped pages read; it is seeded disabled like every other seed and enabled in
 * production by a person after the terms review (README "Seeds").
 *
 *   node test/usda-ers.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const api = require('../server/adapters/api');
const { validateSource } = require('../server/registry');
const { suite } = require('./helpers');

const t = suite('usda-ers');
const seed = require('../seeds/sources.json').sources.find((s) => s.key === 'usda-ers-fruit-vegetable-prices');
const source = validateSource(seed);
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

// Food's 16 mapped identities (server/food/usda-prices.js PRODUCTS on 2026-11-06). This test fails if a seed mapping
// or ERS's columns stop producing one of them, so the Food pages never silently lose their USDA price.
const FOOD_IDENTITIES = [
    'Apples | Fresh',
    'Avocados | Fresh',
    'Bananas | Fresh',
    'Black beans | Canned',
    'Carrots, baby | Fresh',
    'Corn | Canned',
    'Grapes (raisins) | Dried',
    'Green beans | Canned',
    'Mixed vegetables, carrots, peas, corn, and green beans | Frozen',
    'Onions | Fresh',
    'Oranges | Fresh',
    'Peaches, in syrup or water | Canned',
    'Pinto beans | Dried',
    'Potatoes | Fresh',
    'Strawberries | Fresh',
    'Tomatoes | Canned',
];

const parse = (endpoint, file) => api.parse(fixture(file), { url: endpoint.url, endpoint, maxItems: 500 });

t('the seed has ERS\'s two CSV files, one item per product and form, still disabled for review', () => {
    assert.ok(seed, 'the source must be seeded');
    assert.strictEqual(source.enabled, false, 'seeding is never permission to fetch');
    assert.strictEqual(source.review_required, true);
    assert.strictEqual(source.category, 'food');
    assert.deepStrictEqual(source.endpoints.map((ep) => [ep.url, ep.format, ep.identity_fields]), [
        ['https://www.ers.usda.gov/media/6210/all-fruits-average-prices-csv-format.csv', 'csv', ['Fruit', 'Form']],
        ['https://www.ers.usda.gov/media/6240/all-vegetables-average-prices-csv-format.csv', 'csv', ['Vegetable', 'Form']],
    ]);
    for (const ep of source.endpoints) assert.strictEqual(api.checkMapping(ep), null, `${ep.url} must be a valid api mapping`);
});

t('the recorded fruits file: 62 rows, none skipped, every price and unit kept as published', () => {
    const r = parse(source.endpoints[0], 'usda-ers-fruits.csv');
    assert.strictEqual(r.items.length, 62);
    assert.strictEqual(r.skipped, 0);
    const units = {};
    for (const item of r.items) units[item.fields.unit] = (units[item.fields.unit] || 0) + 1;
    assert.deepStrictEqual(units, {
        'per pound': 51,
        'per pint (16 fluid ounces ready to drink)': 7,
        'per pint (16 fluid ounces concentrate)': 4,
    });
    const apples = r.items.find((i) => i.identity === 'Apples | Fresh');
    assert.deepStrictEqual([apples.title, apples.fields.price, apples.fields.unit], ['Apples', '1.86093095', 'per pound']);
    assert.ok(r.items.some((i) => i.identity === 'Apples, applesauce | Canned'), 'a quoted comma belongs to the name');
});

t('the recorded vegetables file: 93 rows, none skipped, all priced per pound', () => {
    const r = parse(source.endpoints[1], 'usda-ers-vegetables.csv');
    assert.strictEqual(r.items.length, 93);
    assert.strictEqual(r.skipped, 0);
    assert.deepStrictEqual([...new Set(r.items.map((i) => i.fields.unit))], ['per pound']);
    const onions = r.items.find((i) => i.identity === 'Onions | Fresh');
    assert.deepStrictEqual([onions.title, onions.fields.price], ['Onions', '1.062206305']);
});

t('both files together: 155 distinct identities and every one Food maps is there, per pound', () => {
    const items = [source.endpoints[0], source.endpoints[1]].flatMap((ep, i) => parse(ep, i ? 'usda-ers-vegetables.csv' : 'usda-ers-fruits.csv').items);
    assert.strictEqual(items.length, 155);
    const byIdentity = new Map(items.map((i) => [i.identity, i]));
    assert.strictEqual(byIdentity.size, 155, 'no identity repeats across the two tables');
    for (const identity of FOOD_IDENTITIES) {
        const item = byIdentity.get(identity);
        assert.ok(item, `Food maps ${identity}, which the recorded ERS files no longer state`);
        assert.strictEqual(item.fields.unit, 'per pound', `${identity} must be per pound for Food's pack arithmetic`);
        assert.ok(Number(item.fields.price) > 0);
    }
});

t.run();
