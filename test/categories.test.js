'use strict';
/**
 * The categories a source may have are sources.source@1's, read from openvibe-contracts: housing, food and jobs since
 * contracts 0.210.0 (plan 2026-10-22, track F1: Rent and Homes, Food and Work move their own fetches into Sources).
 * The registry accepts every one of them and refuses anything else, and the items API filters by them.
 */
const assert = require('assert');
const { validateSource, CATEGORIES } = require('../server/registry');
const { suite, sourceDef } = require('./helpers');

const t = suite('categories');

t('the categories are the contract\'s, housing, food and jobs included', () => {
    const contract = require('openvibe-contracts/contracts/sources/source.v1.json').properties.category.enum;
    assert.deepStrictEqual([...CATEGORIES], contract);
    for (const c of ['news', 'hosting', 'games', 'housing', 'food', 'jobs']) assert.ok(CATEGORIES.includes(c), c);
    assert.ok(Object.isFrozen(CATEGORIES));
});

t('the registry accepts a source in each new category and refuses one outside the contract', () => {
    for (const category of ['housing', 'food', 'jobs']) {
        assert.strictEqual(validateSource(sourceDef({ key: `example-${category}`, category, endpoints: ['https://feeds.example.org/feed.xml'] })).category, category);
    }
    assert.throws(() => validateSource(sourceDef({ key: 'example-weather', category: 'weather', endpoints: ['https://feeds.example.org/feed.xml'] })), /category must be one of .*housing\|food\|jobs/);
});

t.run();
