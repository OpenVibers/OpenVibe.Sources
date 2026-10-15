'use strict';
/**
 * sec-company-tickers (seeds/sources.json): SEC's company_tickers_exchange.json is { fields, data: [[cik, name, ticker,
 * exchange], …] }, so the seed's endpoint reads rows by array index. Each row becomes one `instrument` item keyed by
 * its ticker, with the CIK, name and exchange as SEC lists them (a missing exchange is null, never a guess); the whole
 * list (about 10,450 rows) fits under the default per-fetch cap.
 */
const assert = require('assert');
const api = require('../server/adapters/api');
const { validateSource } = require('../server/registry');
const { load } = require('../server/config');
const { suite } = require('./helpers');

const t = suite('sec-company-tickers');
const seed = require('../seeds/sources.json').sources.find((s) => s.key === 'sec-company-tickers');

const BODY = JSON.stringify({
    fields: ['cik', 'name', 'ticker', 'exchange'],
    data: [
        [1045810, 'NVIDIA CORP', 'NVDA', 'Nasdaq'],
        [1652044, 'Alphabet Inc.', 'GOOGL', 'Nasdaq'],
        [1652044, 'Alphabet Inc.', 'GOOG', 'Nasdaq'],
        [1067983, 'BERKSHIRE HATHAWAY INC', 'BRK-B', 'NYSE'],
        [1999999, 'Shell Co', 'SHLL', null],
    ],
});

t('the seed is a disabled, daily api source of instrument items that validates', () => {
    assert.ok(seed, 'sec-company-tickers is seeded');
    const rec = validateSource(seed);
    assert.strictEqual(rec.enabled, false);
    assert.strictEqual(rec.category, 'trade');
    assert.strictEqual(rec.poll_interval_sec, 86400);
    assert.ok(rec.max_items >= 10450 && rec.max_items <= load({}).items.maxPerFetch, 'the whole list fits under the default cap');
});

t('each row is one instrument item keyed by ticker, with the CIK, name and exchange', () => {
    const r = api.parse(BODY, { url: seed.endpoints[0].url, endpoint: seed.endpoints[0], maxItems: seed.max_items });
    assert.strictEqual(r.items.length, 5);
    const [nvda, googl, goog, brk, shell] = r.items;
    assert.strictEqual(nvda.identity, 'NVDA');
    assert.strictEqual(nvda.kind, 'instrument');
    assert.strictEqual(nvda.title, 'NVIDIA CORP');
    assert.deepStrictEqual(nvda.fields, { ticker: 'NVDA', name: 'NVIDIA CORP', cik: 1045810, exchange: 'Nasdaq' });
    assert.strictEqual(googl.fields.cik, goog.fields.cik, 'two share classes, one company');
    assert.strictEqual(brk.identity, 'BRK-B');
    assert.strictEqual(shell.fields.exchange, null, 'a missing exchange stays null');
});

t.run();
