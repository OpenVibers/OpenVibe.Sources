'use strict';
/**
 * Code API (service tokens): GitHub repositories kept by the `github` source.
 *
 *   GET /api/v1/code/repos?list=trending|week|month|hot|new|top&lang=&topic=&limit=
 *       The cached rankings. `hot` is stars gained in the last 24 hours and 7 days from github_stars,
 *       never a total. A list with no reading for a repository leaves its gain null.
 *   GET /api/v1/code/search?q=&lang=&sort=stars|updated|best&page=
 *       A live GitHub repository search through the same client as the scheduled fetch, cached ten
 *       minutes, with GitHub's own query syntax passed through.
 *
 * Both need sources.item.read. The public API is Exchange's; it reads these over loopback.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { CAPS } = require('../auth');
const github = require('../adapters/github');

const LISTS = Object.freeze(['trending', 'week', 'month', 'hot', 'new', 'top']);
const SORTS = Object.freeze(['stars', 'updated', 'best']);
const DAY = 86400000;

const text = (v, max) => (v == null ? null : String(v).trim().slice(0, max) || null);
const number = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

function rowItem(row) {
    let fields = {};
    try { fields = JSON.parse(row.fields) || {}; } catch { fields = {}; }
    return {
        identity: row.identity, canonical_url: row.canonical_url, summary: row.summary,
        title: row.title, fields,
    };
}

async function historyFor(db, names, now) {
    if (!names.length) return new Map();
    const since = github.isoDay(now - 8 * DAY);
    const rows = (await db.query('SELECT full_name, day, stars FROM github_stars WHERE day >= $1 AND full_name = ANY($2)', [since, names])).rows;
    const byName = new Map();
    for (const r of rows) {
        if (!byName.has(r.full_name)) byName.set(r.full_name, []);
        byName.get(r.full_name).push({ day: r.day, stars: Number(r.stars) });
    }
    return byName;
}

function withGains(rows, history, now) {
    return rows.map((row) => {
        const item = rowItem(row);
        const gains = github.gainsFrom(history.get(item.identity) || [], now);
        return { item, gains, repo: github.publicRepository(item, gains) };
    });
}

function sortFor(list) {
    return (a, b) => {
        if (list === 'hot') {
            const a1 = a.gains.days_1, b1 = b.gains.days_1;
            if (a1 != null && b1 != null && a1 !== b1) return b1 - a1;
            if (a1 != null && b1 == null) return -1;
            if (a1 == null && b1 != null) return 1;
            const a7 = a.gains.days_7, b7 = b.gains.days_7;
            if (a7 != null && b7 != null && a7 !== b7) return b7 - a7;
        }
        if (list === 'new') {
            const ac = Date.parse(a.repo.created || 0) || 0;
            const bc = Date.parse(b.repo.created || 0) || 0;
            if (ac !== bc) return bc - ac;
        }
        const as = number(a.repo.stars), bs = number(b.repo.stars);
        if (as != null && bs != null && as !== bs) return bs - as;
        if (as != null && bs == null) return -1;
        if (as == null && bs != null) return 1;
        return String(a.repo.full_name).localeCompare(String(b.repo.full_name));
    };
}

function createCodeRouter({ db, registry, auth, limits, github: client }) {
    const router = express.Router();
    const read = [auth.requireCap(CAPS.items), limits.reads('sources.code')];

    router.get('/api/v1/code/repos', read, async (req, res) => {
        const list = LISTS.includes(String(req.query.list || 'trending')) ? String(req.query.list || 'trending') : null;
        if (!list) return http.sendProblem(res, 422, 'sources.bad_query', { detail: `list must be one of ${LISTS.join('|')}` });
        const lang = text(req.query.lang, 60);
        const topic = text(req.query.topic, 50);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
        const t = Date.now();
        const lastDay = t - DAY;
        // Ordering by stars happens in JS: the tracked set is bounded by the source's max_items (3,000) and
        // the gains need the snapshots anyway. A filter narrows it before the sort.
        const rows = (await db.query("SELECT * FROM items WHERE category = 'code' AND removed_at IS NULL ORDER BY retrieved_at DESC LIMIT 5000")).rows;
        const filtered = rows.filter((row) => {
            const item = rowItem(row);
            const f = item.fields || {};
            if (lang && String(f.language || '').toLowerCase() !== lang.toLowerCase()) return false;
            if (topic && !(Array.isArray(f.topics) ? f.topics : []).some((x) => String(x).toLowerCase() === topic.toLowerCase())) return false;
            const created = Date.parse(f.created || '');
            if (list === 'trending' && (!Number.isFinite(created) || created < lastDay)) return false;
            if (list === 'week' && (!Number.isFinite(created) || created < t - 7 * DAY)) return false;
            if (list === 'month' && (!Number.isFinite(created) || created < t - 30 * DAY)) return false;
            if (list === 'new' && (!Number.isFinite(created) || created < t - 7 * DAY)) return false;
            return true;
        });
        const history = await historyFor(db, filtered.map((r) => r.identity), t);
        const ordered = withGains(filtered, history, t).sort(sortFor(list)).slice(0, limit).map((x) => x.repo);
        const source = await registry.get('github');
        const health = source ? registry.health(source) : null;
        res.set('Cache-Control', 'public, max-age=60');
        res.json({
            generated_at: new Date(t).toISOString(),
            list, lang, topic, limit, count: ordered.length,
            source: health ? { key: 'github', status: health.status, stale: health.stale, last_success_at: health.last_success_at } : null,
            items: ordered,
        });
    });

    router.get('/api/v1/code/search', read, async (req, res) => {
        const q = text(req.query.q, 300);
        if (!q) return http.sendProblem(res, 422, 'sources.bad_query', { detail: 'q is required' });
        const lang = text(req.query.lang, 60);
        const sort = SORTS.includes(String(req.query.sort || 'best')) ? String(req.query.sort || 'best') : 'best';
        const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), 10);
        let out;
        try {
            out = await client.search({ q, lang, sort, page });
        } catch (err) {
            if (err.code === 'rate_limited') {
                res.set('Retry-After', String(Math.max(1, Math.ceil((err.retryAfterMs || 60000) / 1000))));
                return http.sendProblem(res, 429, 'sources.rate_limited', { detail: 'GitHub asked us to wait before another search', ctx: req.ov });
            }
            if (err.code === 'bad_query') return http.sendProblem(res, 422, 'sources.bad_query', { detail: err.message, ctx: req.ov });
            return http.sendProblem(res, 502, 'sources.github_unavailable', { detail: 'GitHub search did not answer', ctx: req.ov });
        }
        const names = out.items.map((i) => i.full_name);
        const history = await historyFor(db, names, Date.now());
        const items = out.items.map((repo) => {
            const gains = github.gainsFrom(history.get(repo.full_name) || [], Date.now());
            return { ...repo, stars_gained_1d: gains.days_1, stars_gained_7d: gains.days_7 };
        });
        res.set('Cache-Control', 'public, max-age=600');
        res.json({ ...out, items, count: items.length });
    });

    return router;
}

module.exports = { createCodeRouter, LISTS, SORTS };
