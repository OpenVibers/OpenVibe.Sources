'use strict';

/**
 * Owner settings (D11) for OpenVibe.Sources: the data-source keys in `sources.data_sources`.
 *
 * The read-only GitHub token is read through githubToken() when a GitHub read is made: the value
 * the owner entered in the admin panel wins, SOURCES_GITHUB_TOKEN is the fallback. The token is
 * sealed by the shared store under OV_CONFIG_KEKS and is write-only through
 * /internal/config/sources.data_sources/secrets/github_read_only_token; summaries, history and logs
 * carry markers. Network's admin proxy reaches this namespace with `sources.config.manage`, acting
 * for the owner (X-OV-Subject); a secret change needs X-OV-Fresh: 1. The test route makes one cheap
 * authenticated GitHub read and answers ok or failed in one line, never echoing the token.
 */
const { createConfigStore, adminRoutes } = require('openvibe-shared/config');

const SERVICE = 'sources';
const NAMESPACE = 'sources.data_sources';
const BASE_PATH = '/internal/config';
const GROUP = 'Data sources';

const SCHEMA = Object.freeze({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Sources data sources',
    description: 'The accounts Sources reads its sources with. A source with no key falls back to anonymous reads; the other sources keep working.',
    type: 'object',
    additionalProperties: false,
    properties: {
        github_read_only_token: {
            type: 'string', title: 'GitHub read-only token', 'x-group': GROUP,
            description: 'A GitHub token with read-only access to public repositories. It raises GitHub\'s rate limit for Sources\' reads and lets it read files from private repositories it was given access to; without it those reads are anonymous and limited.',
            'x-owner-input': {
                group: GROUP,
                unlocks: 'GitHub reads for Sources run with the token\'s higher rate limit and can see the private repositories it is allowed to read.',
                get_it_at: 'https://github.com/settings/tokens',
                get_it_how: 'Create a fine-grained token with only read access to public repositories (or the repositories Sources may read), then paste it here.',
                test: true,
            },
            'x-required-for': 'GitHub source reads',
        },
    },
});

const SECRETS = new Set(['github_read_only_token']);
const ACTIVE = { settings: null };

function createSettings({ db, env = process.env, log = console, fetchImpl = globalThis.fetch, probes = null } = {}) {
    let store = null;
    const ready = createConfigStore({
        db, service: SERVICE, namespace: NAMESPACE, schema: SCHEMA,
        classify: (key) => (SECRETS.has(key) ? 'secret' : 'internal'),
        env, log,
    }).then((s) => { store = s; return s; });

    const values = () => (store ? store.get() : {});

    function valueOf(key, envName, fallback = '') {
        const v = values()[key];
        if (v !== undefined && v !== null && v !== '') return v;
        const e = envName ? env[envName] : undefined;
        return e !== undefined && e !== null && e !== '' ? e : fallback;
    }

    /** The read-only GitHub token, read when a GitHub read is made. */
    function githubToken() { return valueOf('github_read_only_token', 'SOURCES_GITHUB_TOKEN', ''); }

    async function test(key) {
        if (key !== 'github_read_only_token') return { ok: false, detail: 'That setting has no test.' };
        const token = githubToken();
        if (!token) return { ok: false, detail: 'GitHub is not configured: paste the read-only token first.' };
        const probe = probes && typeof probes.github === 'function'
            ? probes.github
            : async ({ token: value }) => {
                const r = await fetchImpl('https://api.github.com/rate_limit', {
                    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${value}`, 'user-agent': 'OpenVibe.Sources', 'x-github-api-version': '2022-11-28' },
                });
                let body = {};
                try { body = await r.json(); } catch { /* not JSON */ }
                if (!r.ok) throw new Error(`HTTP ${r.status}${body && body.message ? `: ${body.message}` : ''}`);
            };
        try {
            await probe({ token });
            return { ok: true, detail: 'ok — GitHub answered the rate-limit read with this token.' };
        } catch (err) {
            const words = String((err && err.message) || 'the request failed').split(/\s+/).join(' ').slice(0, 160);
            return { ok: false, detail: `failed — GitHub said: ${words.split(token).join('[redacted]')}` };
        }
    }

    function mount(app, { guard, log: appLog = log } = {}) {
        if (!store) throw new Error('createSettings: await ready before mount()');
        const routes = adminRoutes([store], {
            basePath: BASE_PATH,
            requireAdmin: guard,
            actor: (req) => {
                const id = String(req.get('x-ov-subject') || '').trim();
                return /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(id) ? { type: 'user', id } : null;
            },
            requireFresh: (req) => String(req.get('x-ov-fresh') || '') === '1',
            log: appLog,
        });
        app.use(routes.handle);
        app.post(`${BASE_PATH}/:namespace/test/:key`, guard, async (req, res) => {
            if (req.params.namespace !== NAMESPACE) return res.status(404).json({ error: 'no such configuration namespace' });
            let key = String(req.params.key || '');
            try { key = decodeURIComponent(key); } catch { /* keep it as it is */ }
            if (!SCHEMA.properties[key]) return res.status(404).json({ error: 'no such setting' });
            try {
                const out = await test(key);
                return res.status(200).json({ ok: Boolean(out.ok), detail: String(out.detail).replace(/\s+/g, ' ').slice(0, 200) });
            } catch (err) {
                appLog.warn(`[config] ${NAMESPACE}: the test for ${key} failed: ${String((err && err.message) || err).slice(0, 160)}`);
                return res.status(200).json({ ok: false, detail: 'failed — the test did not finish. The service log has the reason.' });
            }
        });
        return routes;
    }

    return { namespace: NAMESPACE, schema: SCHEMA, ready, value: valueOf, get: values, githubToken, test, mount };
}

function activate(settings) { ACTIVE.settings = settings; return settings; }
function githubToken() {
    if (ACTIVE.settings) return ACTIVE.settings.githubToken();
    return process.env.SOURCES_GITHUB_TOKEN || '';
}

module.exports = { SERVICE, NAMESPACE, SCHEMA, SECRETS, createSettings, activate, githubToken };
