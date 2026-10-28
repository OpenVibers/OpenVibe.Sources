'use strict';
/** The merchant opt-in pages: a guest sees how it works, a signed-in merchant adds/proves/withdraws with plain forms. */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, request, userToken, suite } = require('./helpers');

const t = suite('merchant-pages');
let svc;
const ALICE = ids.newId('user');
const BOB = ids.newId('user');
const ALICE_TOKEN = userToken(ALICE, { username: 'alice' });
const BOB_TOKEN = userToken(BOB, { username: 'bob' });
let claimId;
let sourceKey;

const cookies = (token) => ({ cookie: `ov_token=${token}` });
const page = (method, p, token, opts = {}) => request(svc.base, method, p, { ...opts, headers: { ...(token ? cookies(token) : {}), ...(opts.headers || {}) } });
const csrfOf = (html) => {
    const m = String(html).match(/name="csrf" value="([^"]+)"/);
    assert.ok(m, 'the page carries a CSRF token');
    return m[1];
};

t('boot with an injectable DNS resolver', async () => {
    const records = new Map();
    svc = await boot({
        resolver: {
            async resolveTxt(name) {
                if (!records.has(name)) { const err = new Error('none'); err.code = 'ENOTFOUND'; throw err; }
                return records.get(name);
            },
        },
        env: { BASE_URL: 'https://sources.test' },
    });
    svc.dns = records;
});

t('a guest sees the pitch and a sign-in link, not the form', async () => {
    const r = await page('GET', '/merchant');
    assert.strictEqual(r.status, 200);
    assert.match(r.text, /List your store on OpenVibe/);
    assert.match(r.text, /Sign in with OpenVibe/);
    assert.match(r.text, /DNS TXT record or a meta tag/);
    assert.doesNotMatch(r.text, /name="listing_url"/);
    assert.strictEqual((await page('POST', '/merchant/sources', null, { redirect: 'manual', form: {} })).status, 303);
});

t('a signed-in merchant adds a domain and sees the DNS instructions', async () => {
    const list = await page('GET', '/merchant', ALICE_TOKEN);
    assert.strictEqual(list.status, 200);
    assert.match(list.text, /Signed in as alice/);
    assert.match(list.text, /Add a store/);
    const csrf = csrfOf(list.text);
    const created = await page('POST', '/merchant/sources', ALICE_TOKEN, {
        redirect: 'manual',
        form: {
            csrf, domain: 'shop.example.com', store_name: 'Example Shop', method: 'dns', listing_kind: 'sitemap',
            listing_url: 'https://shop.example.com/sitemap.xml', meta_url: '',
        },
    });
    assert.strictEqual(created.status, 303, created.text);
    const location = created.headers.get('location');
    assert.match(location, /^\/merchant\/sources\/msrc_[0-9A-HJKMNP-TV-Z]{26}\?created=1$/);
    claimId = location.match(/\/merchant\/sources\/(msrc_[0-9A-HJKMNP-TV-Z]{26})/)[1];

    const detail = await page('GET', `/merchant/sources/${claimId}`, ALICE_TOKEN);
    assert.strictEqual(detail.status, 200);
    assert.match(detail.text, /_openvibe-sources\.shop\.example\.com/);
    assert.match(detail.text, /openvibe-sources-verification=[a-f0-9]{40}/);
    assert.match(detail.text, /Check now/);
    assert.match(detail.text, /No source exists yet/);
});

t('check now says pending; after the TXT record is published it creates and shows the source', async () => {
    const detail = await page('GET', `/merchant/sources/${claimId}`, ALICE_TOKEN);
    const csrf = csrfOf(detail.text);
    const pending = await page('POST', `/merchant/sources/${claimId}/verify`, ALICE_TOKEN, {
        redirect: 'manual', form: { csrf },
    });
    assert.strictEqual(pending.status, 303);
    assert.match(pending.headers.get('location'), /\?pending=1$/);
    const still = await page('GET', `/merchant/sources/${claimId}?pending=1`, ALICE_TOKEN);
    assert.match(still.text, /proof was not found yet|no TXT record/i);

    const tokenValue = still.text.match(/openvibe-sources-verification=([a-f0-9]{40})/)[1];
    svc.dns.set('_openvibe-sources.shop.example.com', [[`openvibe-sources-verification=${tokenValue}`]]);
    const ok = await page('POST', `/merchant/sources/${claimId}/verify`, ALICE_TOKEN, {
        redirect: 'manual', form: { csrf: csrfOf(still.text) },
    });
    assert.strictEqual(ok.status, 303);
    assert.match(ok.headers.get('location'), /\?verified=1$/);

    const done = await page('GET', `/merchant/sources/${claimId}?verified=1`, ALICE_TOKEN);
    assert.match(done.text, /The source is enabled/);
    assert.match(done.text, /explicit permission/);
    assert.match(done.text, /robots\.txt/);
    assert.match(done.text, /Example Shop/);
    sourceKey = done.text.match(/<code>(merchant-shop-example-com-[a-z0-9]{8})<\/code>/)[1];
    assert.ok(sourceKey);
});

t('another merchant cannot open the claim; a missing CSRF token is refused', async () => {
    assert.strictEqual((await page('GET', `/merchant/sources/${claimId}`, BOB_TOKEN)).status, 404);
    const detail = await page('GET', `/merchant/sources/${claimId}`, ALICE_TOKEN);
    const forged = await page('POST', `/merchant/sources/${claimId}/verify`, ALICE_TOKEN, { form: { csrf: 'not-the-token' } });
    assert.strictEqual(forged.status, 403);
    assert.match(forged.text, /form expired/);
    assert.ok(detail.text.includes('Withdraw permission'));
});

t('withdrawal disables the source and the page says the note is kept', async () => {
    const detail = await page('GET', `/merchant/sources/${claimId}`, ALICE_TOKEN);
    const withdrawn = await page('POST', `/merchant/sources/${claimId}/withdraw`, ALICE_TOKEN, {
        redirect: 'manual', form: { csrf: csrfOf(detail.text) },
    });
    assert.strictEqual(withdrawn.status, 303);
    assert.match(withdrawn.headers.get('location'), /\?withdrawn=1$/);
    const after = await page('GET', `/merchant/sources/${claimId}?withdrawn=1`, ALICE_TOKEN);
    assert.match(after.text, /Permission withdrawn/);
    assert.match(after.text, /terms note is kept/);
    assert.match(after.text, /explicit permission/, 'the permission note is still visible');
    assert.match(after.text, /<dd>no<\/dd>/, 'the source is disabled');
    assert.doesNotMatch(after.text, /Withdraw permission/);
});

t('sign-in redirects to the Network OAuth client with the merchant callback', async () => {
    const r = await request(svc.base, 'GET', '/merchant/login?next=%2Fmerchant', { redirect: 'manual' });
    assert.strictEqual(r.status, 302);
    const location = new URL(r.headers.get('location'));
    assert.strictEqual(location.origin, 'https://openvibe.network');
    assert.strictEqual(location.pathname, '/oauth/authorize');
    assert.strictEqual(location.searchParams.get('client_id'), 'sources');
    assert.strictEqual(location.searchParams.get('redirect_uri'), 'https://sources.test/merchant/callback');
    assert.ok(location.searchParams.get('state'));
    assert.match(r.headers.get('set-cookie') || '', /ov_merchant_state=/);
});

t('done', async () => { await svc.stop(); });

t.run();
