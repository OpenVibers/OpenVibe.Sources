'use strict';
/**
 * API adapter: `*` (the single child of an object), `$root.` paths with `{$key}`, and `where`
 * filtering. The fixture is shaped like the AWS Lightsail price list: `products` is keyed by SKU
 * and the prices live under `terms.OnDemand.<SKU>.<offer>.priceDimensions.<dim>.pricePerUnit.USD`,
 * where the `<offer>` and `<dim>` keys are generated and unknown.
 */
const assert = require('assert');
const api = require('../server/adapters/api');
const { suite } = require('./helpers');

const t = suite('api-join');

const LIGHTSAIL = JSON.stringify({
    products: {
        'SKU-LINUX': { productFamily: 'Lightsail Instance', attributes: { operatingSystem: 'Linux', vcpu: 2, memory: '4 GiB', bundled: true } },
        'SKU-WIN': { productFamily: 'Lightsail Instance', attributes: { operatingSystem: 'Windows', vcpu: 2, memory: '4 GiB', bundled: true } },
        'SKU-STORE': { productFamily: 'Storage', attributes: { storageMedia: 'SSD', vcpu: 2 } },
        'SKU-NOPRICE': { productFamily: 'Lightsail Instance', attributes: { operatingSystem: 'Linux', vcpu: 1, memory: '1 GiB', bundled: false } },
    },
    terms: {
        OnDemand: {
            'SKU-LINUX': { 'SKU-LINUX.offer': { priceDimensions: { 'SKU-LINUX.dim': { pricePerUnit: { USD: '0.024' }, unit: 'Hrs' } } } },
            'SKU-WIN': { 'SKU-WIN.offer': { priceDimensions: { 'SKU-WIN.dim': { pricePerUnit: { USD: '0.048' }, unit: 'Hrs' } } } },
            'SKU-STORE': { 'SKU-STORE.offer': { priceDimensions: { 'SKU-STORE.dim': { pricePerUnit: { USD: '0.10' }, unit: 'GB-Mo' } } } },
        },
    },
});

const joinEndpoint = {
    format: 'json', items_path: 'products', items_shape: 'map', item_kind: 'instance',
    fields: { identity: '$key', title: 'attributes.operatingSystem' },
    extra: {
        family: 'productFamily',
        os: 'attributes.operatingSystem',
        vcpu: 'attributes.vcpu',
        price_hourly: '$root.terms.OnDemand.{$key}.*.priceDimensions.*.pricePerUnit.USD',
        unit: '$root.terms.OnDemand.{$key}.*.priceDimensions.*.unit',
    },
};

t('a `*` segment steps into the single child of an object; arrays and multi-key objects give null', () => {
    const endpoint = {
        format: 'json', items_path: 'rows', fields: { identity: 'id' },
        extra: { one: 'obj.*.v', many: 'multi.*.v', arr: 'list.*.v', deeper: 'obj.*.nope' },
    };
    assert.strictEqual(api.checkMapping(endpoint), null);
    const body = JSON.stringify({ rows: [{ id: 'a', obj: { inner: { v: 'yes' } }, multi: { x: 1, y: 2 }, list: [{ v: 'no' }] }] });
    const r = api.parse(body, { url: 'https://x.example/', endpoint });
    assert.deepStrictEqual(r.items[0].fields, { one: 'yes', many: null, arr: null, deeper: null });
});

t('$root paths join a keyed record to prices elsewhere in the response, using {$key} and *', () => {
    assert.strictEqual(api.checkMapping(joinEndpoint), null);
    const r = api.parse(LIGHTSAIL, { url: 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/Lightsail/current/index.json', endpoint: joinEndpoint });
    assert.deepStrictEqual(r.items.map((i) => i.identity), ['SKU-LINUX', 'SKU-NOPRICE', 'SKU-STORE', 'SKU-WIN']);
    assert.deepStrictEqual([r.skipped, r.meta.filtered], [0, 0]);
    const by = Object.fromEntries(r.items.map((i) => [i.identity, i.fields]));
    assert.strictEqual(by['SKU-LINUX'].price_hourly, '0.024');
    assert.strictEqual(by['SKU-WIN'].price_hourly, '0.048');
    assert.strictEqual(by['SKU-STORE'].price_hourly, '0.10');
    assert.strictEqual(by['SKU-NOPRICE'].price_hourly, null, 'no terms entry for this SKU -> null');
    assert.deepStrictEqual([by['SKU-LINUX'].unit, by['SKU-STORE'].unit, by['SKU-NOPRICE'].unit], ['Hrs', 'GB-Mo', null]);
    assert.strictEqual(r.items.find((i) => i.identity === 'SKU-WIN').title, 'Windows', 'record-relative fields still resolve');
});

t('`where` keeps records matching every condition and counts the rest in meta.filtered', () => {
    const linux = { ...joinEndpoint, where: { productFamily: 'Lightsail Instance', 'attributes.operatingSystem': 'Linux' } };
    assert.strictEqual(api.checkMapping(linux), null);
    const r = api.parse(LIGHTSAIL, { url: 'https://x.example/', endpoint: linux });
    assert.deepStrictEqual(r.items.map((i) => i.identity), ['SKU-LINUX', 'SKU-NOPRICE']);
    assert.strictEqual(r.meta.filtered, 2, 'SKU-STORE (family) and SKU-WIN (os)');
    assert.strictEqual(r.skipped, 0, 'filtered records are not skipped');

    // an array expectation matches any; a number compares after scalar()
    const any = { ...joinEndpoint, where: { 'attributes.operatingSystem': ['Linux', 'Windows'], 'attributes.vcpu': 2 } };
    const r2 = api.parse(LIGHTSAIL, { url: 'https://x.example/', endpoint: any });
    assert.deepStrictEqual(r2.items.map((i) => i.identity), ['SKU-LINUX', 'SKU-WIN']);
    assert.strictEqual(r2.meta.filtered, 2, 'SKU-NOPRICE is vcpu 1; SKU-STORE has no operatingSystem');

    // a boolean condition, and `$key` as a where path
    const keyed = { ...joinEndpoint, where: { 'attributes.bundled': true, '$key': ['SKU-LINUX', 'SKU-WIN', 'SKU-STORE'] } };
    assert.strictEqual(api.checkMapping(keyed), null);
    const r3 = api.parse(LIGHTSAIL, { url: 'https://x.example/', endpoint: keyed });
    assert.deepStrictEqual(r3.items.map((i) => i.identity), ['SKU-LINUX', 'SKU-WIN']);
    assert.strictEqual(r3.meta.filtered, 2, 'SKU-STORE has no bundled; SKU-NOPRICE is false');
});

t('maxItems counts only kept records; filtering runs before the cap', () => {
    const ep = { ...joinEndpoint, where: { productFamily: 'Lightsail Instance', 'attributes.operatingSystem': 'Linux' } };
    const r = api.parse(LIGHTSAIL, { url: 'https://x.example/', endpoint: ep, maxItems: 1 });
    assert.deepStrictEqual(r.items.map((i) => i.identity), ['SKU-LINUX']);
    assert.strictEqual(r.meta.filtered, 2, 'the two non-Linux records are filtered, not skipped');
    assert.strictEqual(r.skipped, 1, 'SKU-NOPRICE passed the filter but is past maxItems');
});

t('checkMapping validates the new syntax and rejects malformed variants', () => {
    const map = { items_shape: 'map', fields: { identity: '$key' } };
    assert.strictEqual(api.checkMapping(joinEndpoint), null);
    assert.strictEqual(api.checkMapping({ ...map, where: { '$key': ['a'], x: 'y', '*'  : 'z' } }), null);
    // {$key} outside a $root. path
    assert.match(api.checkMapping({ ...map, extra: { x: '{$key}' } }), /\{\$key\} is only valid inside a \$root\. path/);
    assert.match(api.checkMapping({ ...map, where: { 'a.{$key}': 'x' } }), /\{\$key\} is only valid inside a \$root\. path/);
    // $root alone must be followed by a path
    assert.match(api.checkMapping({ ...map, extra: { x: '$root' } }), /\$root must be followed by a path/);
    // $key mixed into a longer path, and bare $key inside a $root. path
    assert.match(api.checkMapping({ ...map, extra: { x: 'a.$key' } }), /exactly "\$key"/);
    assert.match(api.checkMapping({ ...map, extra: { x: '$root.a.$key' } }), /use "\{\$key\}"/);
    // {$key} still needs items_shape "map"
    assert.match(api.checkMapping({ fields: { identity: 'a' }, extra: { x: '$root.a.{$key}' } }), /\{\$key\} requires items_shape "map"/);
    // where expectations must be scalars, at most 20 of them
    assert.match(api.checkMapping({ ...map, where: { x: { y: 1 } } }), /strings, numbers or booleans/);
    assert.match(api.checkMapping({ ...map, where: { x: [null] } }), /strings, numbers or booleans/);
    assert.match(api.checkMapping({ ...map, where: { x: Array.from({ length: 21 }, (_, i) => i) } }), /at most 20/);
    // at most 10 conditions, and where itself is an object
    const eleven = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, 'v']));
    assert.match(api.checkMapping({ ...map, where: eleven }), /at most 10/);
    assert.match(api.checkMapping({ ...map, where: ['x'] }), /where must be an object/);
});

t('the registry stores `where` only when an endpoint gives it', () => {
    const { validateSource } = require('../server/registry');
    const endpoint = { url: 'https://x.example/', items_path: 'products', items_shape: 'map', fields: { identity: '$key' } };
    const base = { key: 'lightsail', name: 'Lightsail prices', type: 'api', category: 'hosting', endpoints: [endpoint] };
    assert.ok(!('where' in validateSource(base).endpoints[0]));
    const stored = validateSource({ ...base, endpoints: [{ ...endpoint, where: { productFamily: 'Lightsail Instance' } }] });
    assert.deepStrictEqual(stored.endpoints[0].where, { productFamily: 'Lightsail Instance' });
});

t('an endpoint without the new keys parses exactly as before', () => {
    const endpoint = {
        format: 'json', items_path: 'deals', item_kind: 'offer',
        fields: { identity: 'dealID', url: 'link' },
        extra: { sale_price: 'salePrice' },
    };
    assert.strictEqual(api.checkMapping(endpoint), null);
    const r = api.parse('{"deals":[{"dealID":"a","link":"https://shop.example/d/a","salePrice":"4.99"},null,{"dealID":"b"}]}', { url: 'https://api.example.com/deals', endpoint });
    assert.deepStrictEqual(r.items.map((i) => i.identity), ['a', 'b']);
    assert.strictEqual(r.skipped, 1, 'the null element');
    assert.strictEqual(r.meta.filtered, 0, 'no where -> nothing filtered');
    assert.strictEqual(r.items[0].canonical_url, 'https://shop.example/d/a');
    assert.strictEqual(r.items[0].fields.sale_price, '4.99');
    assert.strictEqual(r.items[1].canonical_url, null);
});

t.run();
