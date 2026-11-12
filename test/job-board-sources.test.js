'use strict';
/**
 * Job boards in the jobs category (plan 2026-10-22, track F): RemoteOK's API is read by Sources instead of
 * OpenVibe.Work, under its own robots and terms. The response opens with a legal notice, not a listing, so the
 * mapping requires a position and the notice is filtered out. A listing keeps the board's id, its URL, the company,
 * place, tags and salary bounds, exactly the fields Work's own fetch kept.
 *
 * Remotive is deliberately not seeded: its robots.txt disallows /api/* (checked from the production host), and
 * Sources does not fetch a disallowed path. Work keeps reading that API directly, as its terms grant.
 */
const assert = require('assert');
const api = require('../server/adapters/api');
const { validateSource, CATEGORIES } = require('../server/registry');
const { load } = require('../server/config');
const { suite } = require('./helpers');

const t = suite('job-board-sources');
const seeds = require('../seeds/sources.json').sources;
const remoteok = seeds.find((s) => s.key === 'remoteok-job-board');

const NOTICE = { last_updated: 1794384008, legal: 'API Terms of Service: Please link back (with follow, and without nofollow!) to the URL on Remote OK and mention Remote OK as a source.' };
const JOB = {
    slug: 'remote-devops-engineer-skyward-1049001',
    id: '1049001',
    date: '2026-11-10T00:00:15+00:00',
    company: 'Skyward Cloud',
    position: 'Remote DevOps Engineer',
    tags: ['devops', 'kubernetes'],
    description: '<h2>About the role</h2><p>Run our Kubernetes fleet.</p>',
    location: 'Worldwide',
    salary_min: 90000,
    salary_max: 130000,
    url: 'https://remoteok.com/remote-jobs/remote-devops-engineer-skyward-1049001',
};
const BODY = JSON.stringify([NOTICE, JOB, { id: 'no-position', company: 'Empty' }]);

t('the RemoteOK seed validates, is a disabled jobs source, and is read every 6 hours', () => {
    assert.ok(remoteok, 'remoteok-job-board is seeded');
    assert.ok(CATEGORIES.includes('jobs'));
    const rec = validateSource(remoteok);
    assert.strictEqual(rec.enabled, false);
    assert.strictEqual(rec.review_required, true);
    assert.strictEqual(rec.category, 'jobs');
    assert.ok(rec.robots_note && rec.terms_note, 'robots and terms notes');
    assert.strictEqual(new URL(remoteok.endpoints[0].url).host, 'remoteok.com');
    assert.strictEqual(rec.poll_interval_sec, 21600);
    assert.strictEqual(rec.retire_after_sec, 2592000, 'a job the board stopped showing is retired after 30 days');
    assert.ok(rec.max_items <= load({}).items.maxPerFetch);
});

t('the legal notice is filtered out and a listing keeps the board\'s own id, URL, fields and lists', () => {
    const out = api.parse(BODY, { url: remoteok.endpoints[0].url, endpoint: remoteok.endpoints[0], maxItems: remoteok.max_items });
    assert.strictEqual(out.items.length, 1);
    assert.strictEqual(out.meta.filtered, 2, 'the notice and the record with no position');
    const [job] = out.items;
    assert.strictEqual(job.kind, 'job');
    assert.strictEqual(job.identity, '1049001');
    assert.strictEqual(job.canonical_url, JOB.url);
    assert.strictEqual(job.title, 'Remote DevOps Engineer');
    assert.strictEqual(job.summary, 'About the role Run our Kubernetes fleet.');
    assert.strictEqual(job.published_at, '2026-11-10T00:00:15.000Z');
    assert.deepStrictEqual(job.fields, {
        company: 'Skyward Cloud',
        location: 'Worldwide',
        job_type: null,
        salary_min: 90000,
        salary_max: 130000,
        tags: ['devops', 'kubernetes'],
    });
});

t('Remotive is not a source: its robots.txt disallows the API path Sources would have to fetch', () => {
    assert.ok(!seeds.some((s) => /remotive/i.test(s.key)), 'Remotive stays outside Sources');
});

t.run();
