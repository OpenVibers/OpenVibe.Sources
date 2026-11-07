'use strict';
/**
 * Owner settings (D11) for Sources' data sources (server/settings.js, sources.data_sources):
 *   - the read-only GitHub token has a plain title, a 30+ character description, x-owner-input
 *     words and a test;
 *   - /internal/config is loopback only and needs sources.config.manage;
 *   - the token is write-only and marked in summaries, githubToken() reads the owner's value and
 *     falls back to SOURCES_GITHUB_TOKEN, and the test hook never echoes or logs the token.
 *   node test/owner-settings.test.js
 */
const assert = require('assert');
const http = require('http');
const express = require('express');
const { boot, request, serviceToken } = require('./helpers');
const { createSettings } = require('../server/settings');

const CAP = 'sources.config.manage';
const NS = 'sources.data_sources';
const USR = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3';
const TOKEN = 'github-owner-token-sentinel';

(async () => {
    const lines = [];
    const log = { log: (...a) => lines.push(a.join(' ')), info: (...a) => lines.push(a.join(' ')), warn: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) };
    const svc = await boot({ log });
    const bearer = serviceToken('network', [CAP]);
    const checks = [];
    const check = async (name, fn) => {
        try { await fn(); checks.push(name); console.log(`  ✓ ${name}`); } catch (e) { console.log(`  ✗ ${name}\n${e.stack}`); await svc.stop(); process.exit(1); }
    };

    await check('the GitHub token has owner words and a test', async () => {
        const r = await request(svc.base, 'GET', `/internal/config/${NS}`, { token: bearer });
        assert.strictEqual(r.status, 200, r.text);
        const f = r.body.schema.properties.github_read_only_token;
        assert.ok(f);
        assert.ok(f.title && f.title.length >= 3);
        assert.ok(f.description && f.description.length >= 30);
        assert.strictEqual(f['x-owner-input'].group, 'data-sources');
        assert.ok(f['x-owner-input'].unlocks.length > 20);
        assert.strictEqual(f['x-owner-input'].get_it_at, 'https://github.com/settings/tokens');
        assert.strictEqual(f['x-owner-input'].test, true);
        assert.strictEqual(f['x-required-for'], 'GitHub source reads');
    });

    await check('the routes are loopback only and need the capability', async () => {
        assert.strictEqual((await request(svc.base, 'GET', `/internal/config/${NS}`)).status, 401);
        assert.strictEqual((await request(svc.base, 'GET', `/internal/config/${NS}`, { token: serviceToken('news', ['sources.source.read']) })).status, 403);
        assert.strictEqual((await request(svc.base, 'GET', `/internal/config/${NS}`, { token: bearer, headers: { 'x-forwarded-for': '203.0.113.9' } })).status, 404);
    });

    await check('the token is write-only and the environment is the fallback', async () => {
        const envOnly = createSettings({ db: svc.db, env: { SOURCES_GITHUB_TOKEN: 'github-env-token' } });
        await envOnly.ready;
        assert.strictEqual(envOnly.githubToken(), 'github-env-token', 'the env is the fallback');
        const put = await request(svc.base, 'PUT', `/internal/config/${NS}/secrets/github_read_only_token`, {
            token: bearer, body: { value: TOKEN, reason: 'owner test' }, headers: { 'x-ov-subject': USR, 'x-ov-fresh': '1' },
        });
        assert.strictEqual(put.status, 200, put.text);
        assert.ok(put.body.fingerprint && put.body.hint);
        assert.ok(!put.text.includes(TOKEN));
        const summary = await request(svc.base, 'GET', `/internal/config/${NS}`, { token: bearer });
        assert.ok(summary.body.values.github_read_only_token.redacted);
        assert.ok(!summary.text.includes(TOKEN));
        assert.strictEqual(svc.settings.githubToken(), TOKEN, 'the code reads the owner value when set');
    });

    await check('the test hook says ok/failed in one line and never echoes a token', async () => {
        const fake = createSettings({
            db: svc.db, env: {},
            probes: { github: async ({ token }) => { throw new Error(`refused ${token}`); } },
        });
        await fake.ready;
        const app = express();
        app.use(express.json());
        fake.mount(app, { guard: (_req, _res, next) => next(), log });
        const server = await new Promise((resolve) => { const s = http.createServer(app); s.listen(0, '127.0.0.1', () => resolve(s)); });
        try {
            const r = await fetch(`http://127.0.0.1:${server.address().port}/internal/config/${NS}/test/github_read_only_token`, { method: 'POST' });
            const body = await r.json();
            assert.strictEqual(r.status, 200);
            assert.strictEqual(body.ok, false);
            assert.ok(/^failed — GitHub said: /.test(body.detail), body.detail);
            assert.ok(!body.detail.includes(TOKEN));
            assert.ok(!body.detail.includes('\n'));
        } finally { server.close(); }
        assert.ok(!lines.join('\n').includes(TOKEN), 'no token in a captured log line');
    });

    await svc.stop();
    console.log(`\n${checks.length} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
