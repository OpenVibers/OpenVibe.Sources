'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { suite } = require('./helpers');

const t = suite('merchant-arrival');
const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'merchant-arrival.js'), 'utf8');

async function visit({ hint = '', session = null, referrer = '', pathname = '/', search = '' } = {}) {
    const calls = { fetch: 0, navigations: [], frames: [], message: null };
    const frame = { contentWindow: {}, setAttribute() {}, style: {}, remove() { calls.removed = true; } };
    const document = {
        cookie: hint ? `ov_sso_hint=${hint}` : '', referrer,
        createElement(tag) { assert.strictEqual(tag, 'iframe'); return frame; },
        body: { appendChild(el) { calls.frames.push(el); } },
    };
    const window = {
        addEventListener(type, fn) { assert.strictEqual(type, 'message'); calls.message = fn; },
        removeEventListener() { calls.message = null; },
    };
    const storage = new Map();
    await vm.runInNewContext(script, {
        URL, URLSearchParams, document, window,
        location: { origin: 'https://sources.openvibe.network', pathname, search, replace(url) { calls.navigations.push(url); } },
        navigator: { userAgent: 'Chrome' },
        sessionStorage: { getItem(k) { return storage.get(k) || null; }, setItem(k, v) { storage.set(k, v); } },
        async fetch(url) { assert.strictEqual(url, '/auth/me'); calls.fetch++; return { ok: true, async json() { return { user: session }; } }; },
        setTimeout() { return 1; }, clearTimeout() {},
    });
    return { calls, frame };
}

t('an explicit guest hint makes no session request or navigation', async () => {
    const { calls } = await visit({ hint: 'guest', referrer: 'https://openvibe.network/' });
    assert.strictEqual(calls.fetch, 0);
    assert.deepStrictEqual(calls.navigations, []);
    assert.strictEqual(calls.frames.length, 0);
});

t('an existing Sources session needs no new OAuth flow', async () => {
    const { calls } = await visit({ hint: 'account', session: { username: 'alice' } });
    assert.strictEqual(calls.fetch, 1);
    assert.deepStrictEqual(calls.navigations, []);
});

t('a Network arrival asks the existing OAuth client silently and returns home', async () => {
    const { calls } = await visit({ referrer: 'https://openvibe.network/' });
    assert.deepStrictEqual(calls.navigations, ['/merchant/login?silent=1&next=%2F']);
});

t('the hidden check accepts only Network from its own frame', async () => {
    const { calls, frame } = await visit({ pathname: '/merchant' });
    assert.strictEqual(calls.frames.length, 1);
    assert.match(frame.src, /^https:\/\/openvibe\.network\/sso\/check\?origin=/);
    calls.message({ origin: 'https://other.example', source: frame.contentWindow, data: { type: 'ov-sso', signedIn: true } });
    assert.deepStrictEqual(calls.navigations, []);
    calls.message({ origin: 'https://openvibe.network', source: {}, data: { type: 'ov-sso', signedIn: true } });
    assert.deepStrictEqual(calls.navigations, []);
    calls.message({ origin: 'https://openvibe.network', source: frame.contentWindow, data: { type: 'ov-sso', signedIn: true } });
    assert.deepStrictEqual(calls.navigations, ['/merchant/login?silent=1&next=%2Fmerchant']);
    assert.strictEqual(calls.removed, true);
});

t('a failed silent OAuth attempt does not loop', async () => {
    const { calls } = await visit({ hint: 'account', search: '?sso=none' });
    assert.strictEqual(calls.fetch, 0);
    assert.deepStrictEqual(calls.navigations, []);
});

t.run();
