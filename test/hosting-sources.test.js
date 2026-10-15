'use strict';
/**
 * The hosting seeds: each provider API maps through the api adapter exactly as the registry
 * declares it, and the registry accepts category `hosting` (refusing anything else). The fixtures
 * are the live responses (Vultr /v2/plans, Akamai Linode /v4/linode/types) trimmed to three records,
 * and OVHcloud's US VPS catalog trimmed to five plans and their products.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const api = require('../server/adapters/api');
const { validateSource } = require('../server/registry');
const { suite } = require('./helpers');

const t = suite('hosting-sources');
const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const seeds = require('../seeds/sources.json').sources;
const seed = (key) => seeds.find((s) => s.key === key);
const endpoint = (key) => seed(key).endpoints[0];

t('both hosting seeds declare an api mapping the adapter accepts', () => {
    for (const key of ['vultr-plans', 'linode-types', 'ovhcloud-vps']) {
        const s = seed(key);
        assert.ok(s, `${key} is seeded`);
        assert.strictEqual(s.type, 'api');
        assert.strictEqual(s.category, 'hosting');
        assert.strictEqual(api.checkMapping(endpoint(key)), null, `${key} mapping`);
    }
});

t('Vultr /v2/plans: one item per plan, identity from id, every extra field kept', () => {
    const ep = endpoint('vultr-plans');
    const r = api.parse(fx('vultr-plans.json'), { url: ep.url, endpoint: ep });
    assert.strictEqual(r.skipped, 0);
    assert.deepStrictEqual(r.items.map((i) => i.identity), ['vc2-1c-0.5gb-free', 'vc2-1c-0.5gb-v6', 'vc2-1c-0.5gb']);
    assert.ok(r.items.every((i) => i.kind === 'plan'));
    assert.deepStrictEqual(r.items[0].fields, {
        vcpu_count: 1, ram: 512, disk: 10, disk_count: 1, bandwidth: 0, monthly_cost: 0, hourly_cost: 0, type: 'vc2',
    });
    assert.deepStrictEqual(r.items[2].fields, {
        vcpu_count: 1, ram: 512, disk: 10, disk_count: 1, bandwidth: 512, monthly_cost: 3.5, hourly_cost: 0.005, type: 'vc2',
    });
    assert.strictEqual(r.items[0].title, null, 'no title is mapped for Vultr');
    assert.strictEqual(r.items[0].canonical_url, null, 'no url is mapped for Vultr');
});

t('OVHcloud catalog: only current plan codes, each joined to its product\'s hardware and its monthly no-commitment price', () => {
    const s = seed('ovhcloud-vps');
    assert.deepStrictEqual([s.enabled, s.review_required], [false, true], 'seeded disabled, for a person to enable');
    const ep = endpoint('ovhcloud-vps');
    const r = api.parse(fx('ovhcloud-vps.json'), { url: ep.url, endpoint: ep });
    // The -eu region copy, a legacy upgrade code and an option plan are filtered by the plan-code pattern.
    assert.deepStrictEqual([r.items.map((i) => i.identity), r.meta.filtered, r.skipped], [['vps-2027-model1', 'vps-2025-model6'], 3, 0]);
    assert.deepStrictEqual(r.items.map((i) => i.title), ['VPS-1 2027', 'VPS-6 2026']);
    assert.deepStrictEqual(r.items[0].fields, {
        product: 'vps-2027-model1', currency: 'USD', vcpu: 2, cpu_type: 'vCore', memory_gb: 4, disk_gb: 40, disk_interface: 'NVMe',
        disk_technology: 'SSD', bandwidth_mbps: 500, bandwidth_unlimited: true, price_monthly: 535000000,
    });
    // 8600000000 hundred-millionths: the $86.00 a month plan, not its 12-month commitment price.
    assert.deepStrictEqual([r.items[1].fields.vcpu, r.items[1].fields.memory_gb, r.items[1].fields.price_monthly], [24, 96, 8600000000]);
});

t('Linode /v4/linode/types: identity id, title label, dotted price.monthly/hourly mapped', () => {
    const ep = endpoint('linode-types');
    const r = api.parse(fx('linode-types.json'), { url: ep.url, endpoint: ep });
    assert.strictEqual(r.skipped, 0);
    assert.deepStrictEqual(r.items.map((i) => i.identity), ['g6-nanode-1', 'g6-standard-1', 'g6-standard-2']);
    assert.deepStrictEqual(r.items.map((i) => i.title), ['Nanode 1GB', 'Linode 2GB', 'Linode 4GB']);
    assert.ok(r.items.every((i) => i.kind === 'plan'));
    assert.deepStrictEqual(r.items[0].fields, {
        vcpus: 1, memory: 1024, disk: 25600, transfer: 1000, class: 'nanode', price_monthly: 5, price_hourly: 0.0075,
    });
    assert.deepStrictEqual(r.items[2].fields, {
        vcpus: 2, memory: 4096, disk: 81920, transfer: 4000, class: 'standard', price_monthly: 24, price_hourly: 0.036,
    });
});

t('the registry accepts category hosting and refuses an unknown category', () => {
    const rec = validateSource(seed('vultr-plans'));
    assert.strictEqual(rec.category, 'hosting');
    assert.deepStrictEqual({
        enabled: rec.enabled, review_required: rec.review_required, sensitivity: rec.sensitivity,
        default_indexability: rec.default_indexability, poll_interval_sec: rec.poll_interval_sec,
        min_interval_ms: rec.min_interval_ms, max_items: rec.max_items,
    }, {
        enabled: false, review_required: true, sensitivity: 'none', default_indexability: 'noindex',
        poll_interval_sec: 86400, min_interval_ms: 60000, max_items: 200,
    });
    assert.throws(() => validateSource({ ...seed('vultr-plans'), category: 'hostingg' }), /category must be one of/);
});

t.run();
