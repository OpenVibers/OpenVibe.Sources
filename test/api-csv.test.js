'use strict';
/**
 * API adapter: `format: "csv"` reads a comma-separated file by its header, and `identity_fields` makes the identity
 * from several columns when no single one is unique (USDA ERS prices each product in several forms).
 */
const assert = require('assert');
const api = require('../server/adapters/api');
const { suite } = require('./helpers');

const t = suite('api-csv');

// The USDA ERS all-fruits file as published: UTF-8 BOM, quoted names with commas, padding, and a column per product.
const USDA = [
    '\uFEFFFruit,Form,AverageRetailPrice,AverageRetailPriceUnitOfMeasure,AveragePricePerCupEquivalent',
    'Apples,Fresh,1.86093095,per pound,0.501435057',
    '"Apples, applesauce",Canned,1.208099427,per pound,0.652533815',
    'Bananas,Fresh,0.609594742,per pound,0.31498274',
    '"Grapes (raisins)",Dried,4.328343983,per pound,',
    'Oranges,Fresh,1.439704016,per pound,0.863515806',
    'a broken row with too few values',
    '',
    'Strawberries,Fresh,3.078734363,per pound,1.046999868',
].join('\r\n');

const usdaEndpoint = {
    format: 'csv', items_path: '', item_kind: 'price',
    identity_fields: ['Fruit', 'Form'],
    fields: { title: 'Fruit' },
    extra: { name: 'Fruit', form: 'Form', price: 'AverageRetailPrice', unit: 'AverageRetailPriceUnitOfMeasure' },
};

t('a USDA table: one item per product and form, joined as "name | form"; quoted commas kept, broken rows skipped', () => {
    assert.strictEqual(api.checkMapping(usdaEndpoint), null);
    const r = api.parse(USDA, { url: 'https://www.ers.usda.gov/media/x.csv', endpoint: usdaEndpoint });
    assert.strictEqual(r.meta.format, 'csv');
    assert.deepStrictEqual(r.items.map((i) => i.identity), [
        'Apples | Fresh', 'Apples, applesauce | Canned', 'Bananas | Fresh', 'Grapes (raisins) | Dried', 'Oranges | Fresh', 'Strawberries | Fresh',
    ]);
    assert.deepStrictEqual([r.items[0].title, r.items[0].fields.name, r.items[0].fields.form, r.items[0].fields.price, r.items[0].fields.unit], [
        'Apples', 'Apples', 'Fresh', '1.86093095', 'per pound',
    ]);
    assert.strictEqual(r.items[1].fields.name, 'Apples, applesauce', 'the quoted comma is part of the value');
    assert.strictEqual(r.items[3].fields.price, '4.328343983', 'a trailing empty column is kept as the empty string');
    assert.strictEqual(r.skipped, 1, 'the broken row');
    assert.strictEqual(r.meta.filtered, 0);
});

t('a row missing an identity column is skipped; the first duplicate identity stays', () => {
    const body = 'Fruit,Form,AverageRetailPrice\nApples,Fresh,1.86\nApples,Fresh,9.99\n,Fresh,1.00\nApples,,1.00\n';
    const r = api.parse(body, { url: 'https://x.example/x.csv', endpoint: usdaEndpoint });
    assert.deepStrictEqual(r.items.map((i) => [i.identity, i.fields.price]), [['Apples | Fresh', '1.86']]);
    assert.strictEqual(r.skipped, 3, 'the duplicate and the two rows without a full identity');
    assert.strictEqual(api.checkMapping({ ...usdaEndpoint, duplicates: 'last' }), null);
});

t('mapping rules: csv is an api format, an identity must be named, and identity_fields has bounds', () => {
    assert.strictEqual(api.checkMapping({ ...usdaEndpoint, format: 'tsv' }), null, 'tsv is unchanged');
    assert.match(api.checkMapping({ format: 'yaml', fields: { identity: 'x' } }), /format must be json, xml, tsv or csv/);
    assert.match(api.checkMapping({ ...usdaEndpoint, items_path: 'rows' }), /items_path is ""/);
    assert.match(api.checkMapping({ format: 'csv', identity_fields: ['A'] }), /2 to 8 paths/);
    assert.match(api.checkMapping({ format: 'csv', identity_fields: ['A', 'B'], fields: { identity: 'A' } }), /cannot both be given/);
    assert.match(api.checkMapping({ format: 'csv', fields: {} }), /fields\.identity, fields\.url or identity_fields is required/);
    assert.match(api.checkMapping({ ...usdaEndpoint, items_shape: 'map' }), /identity_fields requires items_shape "array"/);
    assert.match(api.checkMapping({ ...usdaEndpoint, identity_fields: ['Fruit', '$key'] }), /identity_fields: \$key requires items_shape "map"/);
    assert.throws(() => api.parse('a,b\n"unterminated,1', { url: 'https://x.example/x.csv', endpoint: usdaEndpoint }), /ends inside a quoted field/);
});

t('a quoted field may hold a line break and doubled quotes', () => {
    const body = 'Name,Form,Price\n"Apples, ""gala""",Fresh,"1.50"\n"Pears\n(anjou)",Fresh,1.20\n';
    const r = api.parse(body, { url: 'https://x.example/x.csv', endpoint: { format: 'csv', identity_fields: ['Name', 'Form'], fields: { title: 'Name' }, extra: { price: 'Price' } } });
    assert.deepStrictEqual(r.items.map((i) => [i.identity, i.fields.price]), [['Apples, "gala" | Fresh', '1.50'], ['Pears\n(anjou) | Fresh', '1.20']]);
});

t.run();
