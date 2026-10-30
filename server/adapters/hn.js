'use strict';
/**
 * Hacker News "Who is hiring": a resolver, not one items_path. The monthly thread lives across several JSON
 * documents, so this walks the same way a reader would:
 *
 *   user/whoishiring.json  →  the newest story whose title is "Ask HN: Who is hiring?"  →  its top-level
 *   kids  →  item/<id>.json for each comment
 *
 * Only the top-level comments are the job posts; a comment's own kids are never fetched, so a thread of a few
 * hundred posts costs a few hundred requests and no tree walk. One `job` item per comment, with the comment's
 * canonical URL — the full comment is only linked, never stored. The stored excerpt has email addresses and
 * phone numbers replaced with `[email]` and `[phone]`; the title is the first line of the comment, stripped the
 * same way. The API's robots.txt allows only `/*.json` (`Allow: /*.json$`, `Disallow: /`), so every URL this
 * resolver asks for is checked to end in `.json` before it is fetched.
 *
 * A test passes recorded fixtures as `getJson`; nothing here reaches the network by itself.
 */
const { ParseError, toText } = require('./util');

const PARSER_VERSION = 'hn-whoishiring@1';
const STORY_RE = /^Ask HN:\s*Who is hiring\?/i;
const COMMENTS_URL = 'https://news.ycombinator.com/item?id=';

/** The API's robots rule: only a JSON path is allowed. */
function assertJsonUrl(value) {
    let u;
    try { u = new URL(String(value)); } catch { throw new ParseError(`not a URL: ${value}`); }
    if (!u.pathname.endsWith('.json')) throw new ParseError(`the Hacker News API allows only .json paths, not ${u.pathname}`);
    return u.toString();
}

/** HTML entities and tags → the plain text a comment reads as. */
function htmlToText(html) {
    let s = String(html == null ? '' : html);
    s = s.replace(/<\s*(?:p|br)\s*\/?\s*>/gi, '\n');
    s = s.replace(/<[^>]*>/g, '');
    s = s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
        .replace(/&nbsp;/gi, ' ')
        .replace(/&quot;/gi, '"')
        .replace(/&#x27;|&#39;|&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&amp;/gi, '&');
    return s.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// A 10-digit North-American number with optional separators, an international +number, or an extension.
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?:\s?(?:x|ext\.?)\s?\d{1,6})?|\+\d[\d\s().-]{7,}\d/gi;

/** The excerpt's privacy rule: an email or a phone number is not stored. */
function stripPrivate(value) {
    return String(value == null ? '' : value).replace(EMAIL_RE, '[email]').replace(PHONE_RE, '[phone]');
}

/** A plain-text comment → the short stored excerpt (newlines become spaces, privacy applied before the cut). */
function excerptOf(text, max) {
    return stripPrivate(text).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** The first line of a comment, which a Who is hiring post usually uses for company, role and place. */
function titleOf(text) {
    const line = stripPrivate(text).split('\n').map((l) => l.trim()).find(Boolean) || '';
    return line.replace(/^[-–—*•\s]+/, '').slice(0, 200) || null;
}

async function resolve({ endpoint = {}, getJson, maxItems = 500, summaryMax = 1000, cap = 1_000_000 } = {}) {
    if (typeof getJson !== 'function') throw new TypeError('resolve needs getJson');
    const endpointUrl = assertJsonUrl(endpoint.url);
    const u = new URL(endpointUrl);
    const root = new URL('../', u);                                   // …/v0/ from …/v0/user/whoishiring.json
    const userUrl = new URL('user/whoishiring.json', root).toString();
    const json = async (url) => {
        const clean = assertJsonUrl(url);
        const out = await getJson(clean, cap);
        if (out == null || typeof out !== 'object') throw new ParseError(`Hacker News answered ${clean} with no object`);
        return out;
    };

    const user = await json(userUrl);
    const submitted = Array.isArray(user.submitted) ? user.submitted : [];
    let story = null;
    for (const id of submitted.slice(0, 12)) {
        const item = await json(new URL(`item/${id}.json`, root).toString());
        if (item && typeof item.title === 'string' && STORY_RE.test(item.title)) { story = item; break; }
    }
    if (!story) throw new ParseError('user/whoishiring.json has no "Ask HN: Who is hiring?" story');
    const storyUrl = `${COMMENTS_URL}${story.id}`;

    const kids = Array.isArray(story.kids) ? story.kids : [];
    const items = [];
    let skipped = 0;
    for (const id of kids) {
        if (items.length >= maxItems) { skipped += 1; continue; }
        const comment = await json(new URL(`item/${id}.json`, root).toString());
        if (!comment || comment.deleted || comment.dead || typeof comment.text !== 'string') { skipped++; continue; }
        const text = htmlToText(comment.text);
        if (!text) { skipped++; continue; }
        const by = toText(comment.by, 200);
        items.push({
            identity: `hn-${comment.id}`,
            kind: 'job',
            canonical_url: `${COMMENTS_URL}${comment.id}`,
            title: titleOf(text),
            summary: excerptOf(text, summaryMax),
            authors: by ? [by] : [],
            published_at: Number.isFinite(Number(comment.time)) ? new Date(Number(comment.time) * 1000).toISOString() : null,
            updated_at: null,
            fields: { story_id: String(story.id), story_title: toText(story.title, 300), story_url: storyUrl },
        });
    }
    return {
        items, skipped,
        meta: { format: 'json', filtered: 0, story_id: String(story.id), story_title: story.title, story_url: storyUrl, comments: kids.length },
    };
}

module.exports = { resolve, stripPrivate, htmlToText, excerptOf, titleOf, assertJsonUrl, PARSER_VERSION, STORY_RE };
