'use strict';
/**
 * A patch that changes a source's endpoints clears their stored ETag/Last-Modified (endpoint_state), so the next fetch
 * downloads and parses with the new settings; any other patch keeps them. On 2026-10-24 bls-average-prices got its
 * duplicates: last, and the next fetch was a 304 that parsed nothing: the setting would have waited for BLS's monthly
 * file.
 *
 *   node test/registry-validators.test.js
 */
const assert = require('assert');
const { createRegistry } = require('../server/registry');
const { suite } = require('./helpers');

const t = suite('registry-validators');
const source = {
    key: 'tsv-test', name: 'TSV test', type: 'api', category: 'food', homepage_url: 'https://data.example',
    endpoints: [{ url: 'https://data.example/series.tsv', format: 'tsv', items_path: '', item_kind: 'price', fields: { identity: 'series_id' }, extra: { value: 'value' } }],
    robots_note: 'robots.txt read', terms_note: 'public domain', license_note: 'public domain',
};

t('endpoints changed: validators cleared; anything else: kept', async () => {
    const fresh = await require('./db').testDb();
    try {
        const registry = createRegistry({ db: fresh.db });
        await registry.create(source, 'test');
        const put = () => fresh.db.prepare("INSERT INTO endpoint_state (source_key, url, etag, last_modified, last_status, last_fetch_at) VALUES ('tsv-test', 'https://data.example/series.tsv', '\"abc\"', 'Fri, 23 Oct 2026 12:00:00 GMT', 200, 1) ON CONFLICT (source_key, url) DO UPDATE SET etag = excluded.etag").run();
        const count = async () => Number((await fresh.db.prepare("SELECT COUNT(*) AS n FROM endpoint_state WHERE source_key = 'tsv-test'").get()).n);
        await put();
        await registry.patch('tsv-test', { name: 'TSV test, renamed' }, 'test');
        assert.strictEqual(await count(), 1, 'a name change keeps the validators');
        await registry.patch('tsv-test', { endpoints: [{ ...source.endpoints[0], duplicates: 'last' }] }, 'test');
        assert.strictEqual(await count(), 0, 'new endpoint settings: the next fetch is a full one');
    } finally {
        await fresh.close();
    }
});

t.run();
