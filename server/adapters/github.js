'use strict';
/**
 * GitHub repositories for Sources, read from the REST search API only (api.github.com/search/repositories),
 * never from github.com/trending. One run walks a share of the query plan:
 *
 *   - repositories created today, this week and this month, by stars;
 *   - the most-starred repositories pushed in the last 30 days;
 *   - the all-time most-starred;
 *   - the same recent list per language, for the twelve languages with the most repositories on GitHub.
 *
 * Search is limited to 10 requests a minute without a token and 30 with one, so the cursor lives in
 * source_state and a run asks for at most its budget of queries; the remaining ones come on the next run.
 * The scheduler decides when that is (never an interval loop inside a fetch).
 *
 * A star count is kept per repository per day (github_stars). The API computes stars gained over 1 and 7
 * days from those snapshots: a repository first seen yesterday has no 7-day figure and says null, never 0.
 *
 * The mapping keeps what the repository states: full name, URL, description, language, topics, stars,
 * forks, open issues, licence, created, pushed, owner avatar and homepage. A field GitHub does not state
 * is null.
 */
const { toText, toIsoDate, canonicalUrl, toId } = require('./util');

const PARSER_VERSION = 'github@1';
const STATE_NAME = 'github.cursor';
const API = 'https://api.github.com/search/repositories';
const PER_PAGE = 100;

// The twelve languages GitHub's own search facets put at the top of public repositories. A list, not a
// count: the plan is stable and reviewable, and a language added later starts on the next run.
const LANGUAGES = Object.freeze(['JavaScript', 'TypeScript', 'Python', 'Go', 'Rust', 'Java', 'C++', 'C#', 'PHP', 'Ruby', 'Swift', 'Kotlin']);

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const daysAgo = (ms, n) => isoDay(ms - n * 86400000);

/** The queries, in a fixed order: base lists first, then one recent list per language. */
function plan(now = Date.now()) {
    const yesterday = daysAgo(now, 1);
    const week = daysAgo(now, 7);
    const month = daysAgo(now, 30);
    const pushed = daysAgo(now, 30);
    const base = [
        // GitHub's search index has no 'today' bucket until the day closes, so the last 24 hours is the window;
        // the API applies the same 24-hour cutoff to the list.
        { key: 'trending', q: `created:>${yesterday}`, sort: 'stars', order: 'desc' },
        { key: 'week', q: `created:>${week}`, sort: 'stars', order: 'desc' },
        { key: 'month', q: `created:>${month}`, sort: 'stars', order: 'desc' },
        { key: 'pushed', q: `pushed:>${pushed} stars:>100`, sort: 'stars', order: 'desc' },
        { key: 'top', q: 'stars:>10000', sort: 'stars', order: 'desc' },
        { key: 'new', q: `created:>${week}`, sort: 'updated', order: 'desc' },
    ];
    const languages = LANGUAGES.map((language) => ({
        key: `lang:${language}`,
        q: `language:"${language}" created:>${month}`,
        sort: 'stars', order: 'desc',
    }));
    return [...base, ...languages];
}

function queryUrl(query) {
    const u = new URL(API);
    u.searchParams.set('q', query.q);
    if (query.sort) u.searchParams.set('sort', query.sort);
    if (query.order) u.searchParams.set('order', query.order);
    u.searchParams.set('per_page', String(PER_PAGE));
    return u.toString();
}

/** The public item shape: what Exchange and other products read. A number GitHub did not state is null. */
function publicRepository(item, gains = {}) {
    const f = item.fields || {};
    return {
        full_name: item.identity,
        url: item.canonical_url,
        description: item.summary,
        language: f.language == null ? null : f.language,
        topics: Array.isArray(f.topics) ? f.topics : [],
        stars: f.stars == null ? null : f.stars,
        stars_gained_1d: gains.days_1 == null ? null : gains.days_1,
        stars_gained_7d: gains.days_7 == null ? null : gains.days_7,
        forks: f.forks == null ? null : f.forks,
        open_issues: f.open_issues == null ? null : f.open_issues,
        license: f.license == null ? null : f.license,
        created: f.created == null ? null : f.created,
        pushed: f.pushed == null ? null : f.pushed,
        owner_avatar_url: f.owner_avatar_url == null ? null : f.owner_avatar_url,
        homepage: f.homepage == null ? null : f.homepage,
        source: 'github',
    };
}

function repoItem(repo, summaryMax = 1000) {
    const full = toId(repo && repo.full_name, 200);
    if (!full) return null;
    const owner = repo.owner && typeof repo.owner === 'object' ? repo.owner : {};
    const license = repo.license && typeof repo.license === 'object' ? repo.license : null;
    const stars = Number.isFinite(Number(repo.stargazers_count)) ? Math.max(0, Math.trunc(Number(repo.stargazers_count))) : null;
    const fields = {
        stars,
        forks: Number.isFinite(Number(repo.forks_count)) ? Math.max(0, Math.trunc(Number(repo.forks_count))) : null,
        open_issues: Number.isFinite(Number(repo.open_issues_count)) ? Math.max(0, Math.trunc(Number(repo.open_issues_count))) : null,
        language: toText(repo.language, 60),
        topics: Array.isArray(repo.topics) ? repo.topics.map((t) => toText(t, 50)).filter(Boolean).slice(0, 20) : [],
        // SPDX id when GitHub has one; NOASSERTION means GitHub read a licence file but could not name it,
        // so the repository's own string is kept instead of inventing an id.
        license: license ? (license.spdx_id && license.spdx_id !== 'NOASSERTION' ? toText(license.spdx_id, 80) : toText(license.name, 120)) : null,
        created: toIsoDate(repo.created_at),
        pushed: toIsoDate(repo.pushed_at),
        owner_avatar_url: canonicalUrl(owner.avatar_url),
        homepage: canonicalUrl(repo.homepage),
        archived: repo.archived === true,
        fork: repo.fork === true,
    };
    return {
        identity: full,
        kind: 'repository',
        canonical_url: canonicalUrl(repo.html_url) || `https://github.com/${full}`,
        title: full,
        summary: toText(repo.description, summaryMax),
        authors: owner.login ? [toText(owner.login, 200)].filter(Boolean) : [],
        published_at: fields.created,
        updated_at: fields.pushed,
        fields,
    };
}

/** Parse one search answer. A body without an items array is a parse error, never an empty success. */
function parseSearch(body) {
    if (!body || typeof body !== 'object' || !Array.isArray(body.items)) {
        throw Object.assign(new Error('GitHub search did not return an items array'), { code: 'parse_error' });
    }
    return { items: body.items, total: Number.isFinite(Number(body.total_count)) ? Number(body.total_count) : null, incomplete: body.incomplete_results === true };
}

/**
 * Keep one star count per repository per day. Called inside the run transaction; a repository seen twice in
 * one run keeps the last count, which is the same answer GitHub gave later.
 */
async function recordStars(db, sourceKey, list, at) {
    if (!Array.isArray(list) || !list.length) return 0;
    const day = isoDay(at);
    const stmt = db.prepare(`INSERT INTO github_stars (source_key, full_name, day, stars, captured_at) VALUES (@source_key, @full_name, @day, @stars, @captured_at)
        ON CONFLICT (source_key, full_name, day) DO UPDATE SET stars = excluded.stars, captured_at = excluded.captured_at`);
    let n = 0;
    for (const row of list) {
        if (!row || !row.full_name || !Number.isFinite(row.stars)) continue;
        await stmt.run({ source_key: sourceKey, full_name: row.full_name, day, stars: row.stars, captured_at: at });
        n++;
    }
    return n;
}

/** Stars gained over 1 and 7 days from daily snapshots; a window with no snapshot is null. */
function gainsFrom(history, todayMs) {
    const today = isoDay(todayMs);
    const yesterday = isoDay(todayMs - 86400000);
    const weekAgo = isoDay(todayMs - 7 * 86400000);
    const earlier = (limit) => {
        let best = null;
        for (const h of history) if (h.day <= limit && (best == null || h.day > best.day)) best = h;
        return best;
    };
    const latest = earlier(today);
    const d1 = earlier(yesterday);
    const d7 = earlier(weekAgo);
    const stars = latest ? latest.stars : null;
    return {
        stars,
        days_1: stars != null && d1 ? stars - d1.stars : null,
        days_7: stars != null && d7 ? stars - d7.stars : null,
    };
}

module.exports = {
    PARSER_VERSION, STATE_NAME, API, LANGUAGES, plan, queryUrl, repoItem, parseSearch, publicRepository, recordStars, gainsFrom, isoDay,
};
