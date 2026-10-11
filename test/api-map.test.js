'use strict';
/** API adapter: `items_shape: "map"` reads records keyed by id, with the key exposed as `$key`. */
const assert = require('assert');
const api = require('../server/adapters/api');
const { suite } = require('./helpers');

const t = suite('api-map');

// Porkbun-shaped: pricing is an object keyed by TLD, in no particular order in the body.
const PRICING = JSON.stringify({
    pricing: {
        net: { registration: '12.48', renewal: '13.29', meta: { transfer: '12.00' } },
        com: { registration: '10.29', renewal: '10.29', meta: { transfer: '10.29' } },
        org: { registration: '9.99', renewal: '12.99', meta: { transfer: '9.99' } },
        free: 'not a record',
    },
});

const mapEndpoint = {
    format: 'json', items_path: 'pricing', items_shape: 'map', item_kind: 'tld',
    fields: { identity: '$key' },
    extra: { tld: '$key', registration: 'registration', transfer: 'meta.transfer' },
};

t('a map body yields one item per key, sorted, with $key as identity and copied into extra', () => {
    assert.strictEqual(api.checkMapping(mapEndpoint), null);
    const r = api.parse(PRICING, { url: 'https://api.porkbun.com/api/json/v3/pricing/get', endpoint: mapEndpoint });
    assert.strictEqual(r.skipped, 1, 'the non-object value');
    assert.deepStrictEqual(r.items.map((i) => i.identity), ['com', 'net', 'org'], 'sorted key order, not body order');
    assert.deepStrictEqual(r.items.map((i) => i.fields.tld), ['com', 'net', 'org']);
    assert.deepStrictEqual(r.items[0].fields, { tld: 'com', registration: '10.29', transfer: '10.29' });
});

t('nested paths still resolve inside each mapped record', () => {
    const r = api.parse(PRICING, { url: 'https://api.porkbun.com/', endpoint: mapEndpoint });
    assert.deepStrictEqual(r.items.map((i) => i.fields.transfer), ['10.29', '12.00', '9.99']);
});

t('a non-object value is skipped and counted, never invented', () => {
    const r = api.parse(PRICING, { url: 'https://api.porkbun.com/', endpoint: mapEndpoint });
    assert.strictEqual(r.items.length, 3);
    assert.strictEqual(r.skipped, 1);
    assert.ok(!r.items.some((i) => i.identity === 'free'));
    // an array value is not a record either
    const withArray = JSON.stringify({ pricing: { com: { registration: '10.29' }, bad: ['x'] } });
    const r2 = api.parse(withArray, { url: 'https://api.porkbun.com/', endpoint: mapEndpoint });
    assert.deepStrictEqual(r2.items.map((i) => i.identity), ['com']);
    assert.strictEqual(r2.skipped, 1);
});

t('the mapped shape must match the body: map over an array and array over an object both fail', () => {
    assert.throws(
        () => api.parse('{"pricing": [{"registration":"10.29"}]}', { url: 'https://x.example/', endpoint: mapEndpoint }),
        (e) => e.code === 'parse_error' && /not an object/.test(e.message),
    );
    const arrayEndpoint = { format: 'json', items_path: 'pricing', items_shape: 'array', fields: { identity: 'registration' } };
    assert.throws(
        () => api.parse('{"pricing": {"com": {"registration":"10.29"}}}', { url: 'https://x.example/', endpoint: arrayEndpoint }),
        (e) => e.code === 'parse_error' && /not an array/.test(e.message),
    );
});

t('checkMapping refuses $key without items_shape "map" and validates items_shape', () => {
    assert.match(api.checkMapping({ fields: { identity: '$key' } }), /\$key requires items_shape "map"/);
    assert.match(api.checkMapping({ fields: { identity: 'a' }, extra: { tld: '$key' } }), /\$key requires items_shape "map"/);
    assert.match(api.checkMapping({ fields: { identity: '$key' }, items_shape: 'object' }), /items_shape must be array or map/);
    assert.strictEqual(api.checkMapping({ fields: { identity: 'a' }, items_shape: 'array' }), null);
    assert.strictEqual(api.checkMapping({ fields: { identity: 'a' }, items_shape: 'map' }), null);
    // $key as an embedded segment is not the virtual path
    assert.match(api.checkMapping({ fields: { identity: 'a' }, items_shape: 'map', extra: { tld: 'x.$key' } }), /exactly "\$key"/);
});

t('existing array sources are unchanged (items_shape defaults to array)', () => {
    const endpoint = {
        format: 'json', items_path: 'deals', item_kind: 'offer',
        fields: { identity: 'dealID', url: 'link' },
        extra: { sale_price: 'salePrice' },
    };
    assert.strictEqual(api.checkMapping(endpoint), null);
    const r = api.parse('{"deals":[{"dealID":"a","link":"https://shop.example/d/a","salePrice":"4.99"},null,{"dealID":"b"}]}', { url: 'https://api.example.com/deals', endpoint });
    assert.deepStrictEqual(r.items.map((i) => i.identity), ['a', 'b']);
    assert.strictEqual(r.skipped, 1, 'the null element');
    assert.strictEqual(r.items[0].canonical_url, 'https://shop.example/d/a');
    assert.strictEqual(r.items[0].fields.sale_price, '4.99');
    assert.strictEqual(r.items[1].canonical_url, null);
});

t.run();
