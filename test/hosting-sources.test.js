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
    for (const key of ['vultr-plans', 'linode-types', 'ovhcloud-vps', 'ovhcloud-baremetal']) {
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

t('Porkbun prices: one item per TLD from the keyed price list, the prices as Porkbun writes them (Host parses them)', () => {
    const s = seed('porkbun-tld-pricing');
    assert.deepStrictEqual([s.type, s.category, s.enabled, s.review_required], ['api', 'hosting', false, true]);
    const ep = endpoint('porkbun-tld-pricing');
    assert.strictEqual(api.checkMapping(ep), null);
    assert.strictEqual(validateSource(s).max_items, 1200, 'Porkbun sells about 900 names; the whole list fits');
    const r = api.parse(fx('porkbun-pricing.json'), { url: ep.url, endpoint: ep });
    assert.strictEqual(r.skipped, 0);
    assert.deepStrictEqual(r.items.map((i) => i.identity), ['0zebra', 'com', 'com.mx', 'dev', 'protection', 'security', 'xn--q9jyb4c']);
    assert.ok(r.items.every((i) => i.kind === 'tld_price' && i.title === i.identity));
    const by = Object.fromEntries(r.items.map((i) => [i.identity, i.fields]));
    assert.deepStrictEqual(by.dev, { registration: '8.75', renewal: '12.87', transfer: '12.87', special_type: null });
    assert.strictEqual(by.security.registration, '2,060.25', 'thousands separators are kept as given');
    assert.strictEqual(by['0zebra'].special_type, 'handshake', 'Handshake names are marked, for Host to leave out');
});

t('OVHcloud domain prices: one item per ending, the first year, renewal and transfer from the no-premium price modes', () => {
    const s = seed('ovhcloud-domain-pricing');
    assert.deepStrictEqual([s.type, s.category, s.enabled, s.review_required], ['api', 'hosting', false, true]);
    const ep = endpoint('ovhcloud-domain-pricing');
    assert.strictEqual(api.checkMapping(ep), null);
    assert.strictEqual(validateSource(s).max_items, 1200, 'OVHcloud sells about 950 endings; the whole list fits');
    assert.strictEqual(ep.max_bytes, 32 * 1024 * 1024, 'the whole catalog is about 30 MB');
    const r = api.parse(fx('ovhcloud-domain-pricing.json'), { url: ep.url, endpoint: ep, maxItems: 1200 });
    assert.strictEqual(r.skipped, 0);
    assert.deepStrictEqual(r.items.map((i) => i.identity), ['family', 'io', 'shop', 'co.uk', 'dev', 'com']);
    assert.ok(r.items.every((i) => i.kind === 'tld_price'));
    assert.strictEqual(r.items.find((i) => i.identity === 'co.uk').title, '.co.uk');
    const by = Object.fromEntries(r.items.map((i) => [i.identity, i.fields]));
    // Hundred-millionths of a dollar, as the catalog gives them: $9.20 the first year, $16.49 a renewal.
    assert.deepStrictEqual(by.com, { currency: 'USD', register: 920000000, renew: 1649000000, transfer: 920000000 });
    assert.deepStrictEqual(by.io, { currency: 'USD', register: 6299000000, renew: 6269000000, transfer: 5069000000 }, 'never the premium sentinel');
    assert.strictEqual(by['co.uk'].transfer, 0, 'a free transfer stays 0; Host decides what 0 means per field');
});


t('OVHcloud dedicated servers: the bare-metal and Eco catalogs, each plan joined to its default addons and their products', () => {
    const s = seed('ovhcloud-baremetal');
    assert.deepStrictEqual([s.type, s.category, s.enabled, s.review_required], ['api', 'hosting', false, true]);
    assert.strictEqual(s.endpoints.length, 2, 'one endpoint for the bare-metal catalog and one for Eco');
    assert.deepStrictEqual(s.endpoints.map((e) => e.max_bytes), [40 * 1024 * 1024, 16 * 1024 * 1024]);
    for (const ep of s.endpoints) assert.strictEqual(api.checkMapping(ep), null);
    assert.strictEqual(validateSource(s).max_items, 200);

    const main = api.parse(fx('ovhcloud-baremetal.json'), { url: s.endpoints[0].url, endpoint: s.endpoints[0], maxItems: 200 });
    assert.deepStrictEqual([main.items.length, main.meta.filtered, main.skipped], [8, 2, 0]);
    assert.deepStrictEqual(main.items.map((i) => i.identity).sort(), [
        '20bv012-us', '20hg03-us', '22bf062-us', '23scaleamd01-v3-us', '24adv01-v3-us', '24hci-a1-v2-us', '26adv01-v7-us', '26game02-v4-us',
    ]);
    const by = Object.fromEntries(main.items.map((i) => [i.identity, i.fields]));
    assert.deepStrictEqual(by['24adv01-v3-us'], {
        product: '24adv01', currency: 'USD', range: 'advance',
        cpu_cores: 6, cpu_sockets: 1, cpu_model: 'EPYC 4244P', cpu_brand: 'AMD', memory_gb: 32,
        disk_capacity_gb: 960, disk_count: 2, disk_interface: 'NVMe', disk_technology: 'SSD',
        bandwidth_mbps: 3000, bandwidth_limit: 0, price_monthly: 14700000000, setup_fee: 14700000000,
        locations: ['vin', 'hil'],
    });
    // A legacy plan: no installation fee in the catalog ($0), two sockets, SATA SSDs, and a different bandwidth.
    assert.deepStrictEqual([by['20bv012-us'].setup_fee, by['20bv012-us'].cpu_sockets, by['20bv012-us'].memory_gb, by['20bv012-us'].disk_capacity_gb, by['20bv012-us'].disk_count, by['20bv012-us'].bandwidth_mbps, by['20bv012-us'].price_monthly],
        [0, 2, 256, 240, 2, 500, 10900000000]);
    // HG-3's product states no socket count (the CPU model says "2x"); the adapter keeps null rather than inventing one.
    assert.deepStrictEqual([by['20hg03-us'].cpu_cores, by['20hg03-us'].cpu_sockets, by['20hg03-us'].memory_gb, by['20hg03-us'].disk_capacity_gb, by['20hg03-us'].disk_count, by['20hg03-us'].setup_fee, by['20hg03-us'].price_monthly],
        [28, null, 192, 6000, 2, 0, 97500000000]);
    // A Scale plan sold with no drives: capacity 0 and count 0 are the catalog's own facts, not a missing field.
    assert.deepStrictEqual([by['23scaleamd01-v3-us'].disk_capacity_gb, by['23scaleamd01-v3-us'].disk_count], [0, 0]);
    assert.deepStrictEqual([by['24hci-a1-v2-us'].cpu_cores, by['24hci-a1-v2-us'].cpu_sockets, by['24hci-a1-v2-us'].disk_capacity_gb, by['24hci-a1-v2-us'].disk_count], [24, 2, 3840, 6]);
    // The -eu copy and the legacy special edition are filtered by the -us plan-code pattern.
    assert.ok(!main.items.some((i) => /-(?:eu|ca|se)$/.test(i.identity)));

    const eco = api.parse(fx('ovhcloud-eco.json'), { url: s.endpoints[1].url, endpoint: s.endpoints[1], maxItems: 200 });
    assert.deepStrictEqual([eco.items.length, eco.meta.filtered, eco.skipped], [5, 1, 0]);
    const eby = Object.fromEntries(eco.items.map((i) => [i.identity, i.fields]));
    assert.deepStrictEqual([eby['26sk50a-v1-us'].price_monthly, eby['26sk50a-v1-us'].setup_fee, eby['26sk50a-v1-us'].memory_gb, eby['26sk50a-v1-us'].disk_capacity_gb, eby['26sk50a-v1-us'].disk_count],
        [3000000000, 3000000000, 32, 960, 2]);
    assert.deepStrictEqual([eby['24risegame012-us'].range, eby['24risegame012-us'].cpu_cores, eby['24risegame012-us'].disk_capacity_gb, eby['24risegame012-us'].bandwidth_mbps],
        ['rise', 6, 512, 1000]);
    assert.ok(!eco.items.some((i) => i.identity.endsWith('-ca')));
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
