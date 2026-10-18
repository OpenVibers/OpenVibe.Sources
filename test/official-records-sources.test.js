'use strict';
/**
 * Official records for OpenVibe.Reviews (owner, 2026-10-17: Reviews should combine what Glassdoor, Yelp, the BBB… say;
 * the audit's fix: "aggregate permitted signals (official APIs…)"):
 *
 *   cfpb-complaints-by-company   the CFPB's complaint database, one request a week: its per-company buckets become one
 *                                complaint_tally item each (the company's name and its complaint count), CC0
 *   nyc-restaurant-inspections   NYC Health's inspection results on NYC Open Data, the newest 4,000 rows each poll:
 *                                one inspection_violation item per row, keyed by Socrata's row id, with the restaurant
 *                                (camis, name, borough, address, cuisine) and what the inspector recorded
 *   nyc-hpd-open-violations      NYC HPD's housing-code violations, one aggregate query a week: one
 *                                housing_violation_tally item per building with 10 or more open class C violations
 *                                (open by class, the address, the latest inspection), the 4,000 with the most
 *
 * Both validate, start disabled, sit in the reviews category, and fit under the per-fetch cap.
 */
const assert = require('assert');
const api = require('../server/adapters/api');
const { validateSource } = require('../server/registry');
const { load } = require('../server/config');
const { suite } = require('./helpers');

const t = suite('official-records-sources');
const seeds = require('../seeds/sources.json').sources;
const cfpb = seeds.find((s) => s.key === 'cfpb-complaints-by-company');
const nyc = seeds.find((s) => s.key === 'nyc-restaurant-inspections');
const hpd = seeds.find((s) => s.key === 'nyc-hpd-open-violations');

const CFPB_BODY = JSON.stringify({
    took: 12, hits: { total: { value: 18486121, relation: 'eq' }, hits: [] },
    aggregations: {
        product: { doc_count: 18486121, product: { buckets: [{ key: 'Credit reporting', doc_count: 9 }] } },
        company: { doc_count: 18486121, company: { doc_count_error_upper_bound: 0, sum_other_doc_count: 0, buckets: [
            { key: 'CAPITAL ONE FINANCIAL CORPORATION', doc_count: 34041 },
            { key: 'JPMORGAN CHASE & CO.', doc_count: 26433 },
            { key: 'Small Lender LLC', doc_count: 3 },
        ] } },
    },
    _meta: { license: 'CC0', total_record_count: 18486121 },
});

const NYC_BODY = JSON.stringify([
    { ':id': 'row-8nwj_g8up-3hiv', camis: '50071318', dba: 'THE COFFEE CLUB', boro: 'Brooklyn', building: '9526', street: '4 AVENUE', zipcode: '11209', cuisine_description: 'Coffee/Tea',
        inspection_date: '2026-10-15T00:00:00.000', action: 'Violations were cited in the following area(s).', violation_code: '06D',
        violation_description: 'Food contact surface not properly washed, rinsed and sanitized after each use and following any activity when contamination may have occurred.',
        critical_flag: 'Critical', score: '20', inspection_type: 'Cycle Inspection / Initial Inspection' },
    { ':id': 'row-sfm2_r3gx-4bv7', camis: '50071318', dba: 'THE COFFEE CLUB', boro: 'Brooklyn', building: '9526', street: '4 AVENUE', zipcode: '11209', cuisine_description: 'Coffee/Tea',
        inspection_date: '2026-10-15T00:00:00.000', action: 'Violations were cited in the following area(s).', violation_code: '10F', violation_description: 'Non-food contact surface improperly constructed.',
        critical_flag: 'Not Critical', score: '20', inspection_type: 'Cycle Inspection / Initial Inspection' },
    { ':id': 'row-aaaa_bbbb-cccc', camis: '41234567', dba: "JOE'S PIZZA", boro: 'Manhattan', building: '7', street: 'CARMINE STREET', zipcode: '10014', cuisine_description: 'Pizza',
        inspection_date: '2026-10-14T00:00:00.000', action: 'No violations were recorded at the time of this inspection.', critical_flag: 'Not Applicable', score: '0', grade: 'A',
        grade_date: '2026-10-14T00:00:00.000', inspection_type: 'Cycle Inspection / Re-inspection' },
]);

t('the seeds validate, start disabled, are reviews sources and fit under the per-fetch cap', () => {
    for (const s of [cfpb, nyc, hpd]) {
        assert.ok(s, 'seeded');
        const rec = validateSource(s);
        assert.strictEqual(rec.enabled, false);
        assert.strictEqual(rec.category, 'reviews');
        assert.ok(rec.robots_note && rec.terms_note && rec.license_note, `${s.key}: robots, terms and licence notes`);
        assert.ok(rec.max_items <= load({}).items.maxPerFetch, `${s.key} fits under the default cap`);
    }
    assert.strictEqual(cfpb.poll_interval_sec, 604800, 'one request a week');
    assert.ok(nyc.max_items >= 4000);
});

t('CFPB: one complaint_tally item per company bucket, nothing from the other aggregations', () => {
    const r = api.parse(CFPB_BODY, { url: cfpb.endpoints[0].url, endpoint: cfpb.endpoints[0], maxItems: cfpb.max_items });
    assert.strictEqual(r.items.length, 3);
    const [capone] = r.items;
    assert.strictEqual(capone.kind, 'complaint_tally');
    assert.strictEqual(capone.identity, 'CAPITAL ONE FINANCIAL CORPORATION');
    assert.strictEqual(capone.title, 'CAPITAL ONE FINANCIAL CORPORATION');
    assert.deepStrictEqual(capone.fields, { company: 'CAPITAL ONE FINANCIAL CORPORATION', complaints: 34041 });
});

t('NYC: one inspection_violation item per row, keyed by its row id, with the restaurant and the result', () => {
    const r = api.parse(NYC_BODY, { url: nyc.endpoints[0].url, endpoint: nyc.endpoints[0], maxItems: nyc.max_items });
    assert.strictEqual(r.items.length, 3);
    const [a, b, joe] = r.items;
    assert.strictEqual(a.kind, 'inspection_violation');
    assert.strictEqual(a.identity, 'row-8nwj_g8up-3hiv');
    assert.notStrictEqual(a.identity, b.identity, 'two violations at one inspection are two items');
    assert.strictEqual(a.title, 'THE COFFEE CLUB');
    assert.strictEqual(a.fields.camis, '50071318');
    assert.strictEqual(a.fields.critical_flag, 'Critical');
    assert.strictEqual(a.fields.grade, null, 'no grade given at that inspection stays null');
    assert.ok(a.fields.violation.length <= 500);
    assert.deepStrictEqual([joe.fields.grade, joe.fields.score, joe.fields.violation_code, joe.fields.boro], ['A', '0', null, 'Manhattan']);
    // The URL asks Socrata for its row id, leaves out not-yet-inspected rows (1900-01-01) and takes the newest first.
    const u = new URL(nyc.endpoints[0].url);
    assert.match(u.searchParams.get('$select'), /^:id,camis,dba,/);
    assert.strictEqual(u.searchParams.get('$where'), "inspection_date>'2000-01-01'");
    assert.strictEqual(u.searchParams.get('$order'), 'inspection_date DESC');
});

const HPD_BODY = JSON.stringify([
    { buildingid: '288857', boro: 'BROOKLYN', housenumber: '760', streetname: 'ELDERT LANE', zip: '11208', open: '1794', c: '423', b: '1118', a: '252', last: '2026-03-24T00:00:00.000' },
    { buildingid: '60898', boro: 'BRONX', housenumber: '3067', streetname: 'DECATUR AVENUE', zip: '10467', open: '58', c: '27', b: '21', a: '10', last: '2026-10-12T00:00:00.000' },
]);

t('HPD: one housing_violation_tally item per building, open counts by class, a minute to answer', () => {
    const rec = validateSource(hpd);
    assert.strictEqual(rec.endpoints[0].timeout_ms, 120000, 'NYC computes the aggregate in 12 to 60 s');
    assert.strictEqual(hpd.poll_interval_sec, 604800, 'one request a week');
    const r = api.parse(HPD_BODY, { url: hpd.endpoints[0].url, endpoint: hpd.endpoints[0], maxItems: hpd.max_items });
    assert.strictEqual(r.items.length, 2);
    const [eldert] = r.items;
    assert.strictEqual(eldert.kind, 'housing_violation_tally');
    assert.strictEqual(eldert.identity, '288857');
    assert.deepStrictEqual(eldert.fields, { buildingid: '288857', boro: 'BROOKLYN', housenumber: '760', streetname: 'ELDERT LANE', zip: '11208', open: '1794', c: '423', b: '1118', a: '252', last: '2026-03-24T00:00:00.000' });
    const u = new URL(hpd.endpoints[0].url);
    assert.strictEqual(u.searchParams.get('$where'), "violationstatus='Open'");
    assert.strictEqual(u.searchParams.get('$having'), "sum(case(class='C',1,true,0))>=10");
    assert.strictEqual(u.searchParams.get('$limit'), '4000');
});

t.run();
