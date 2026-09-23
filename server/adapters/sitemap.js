'use strict';
/**
 * Sitemaps (sitemaps.org 0.9): a <urlset> → items of kind `url` (loc, lastmod, plus news:news
 * title/date when the Google News extension is present); a <sitemapindex> → items of kind
 * `sitemap` (child sitemaps are listed, not followed: register a child as its own source to
 * ingest it, so every request stays visible and rate-limited).
 * Sitemap entries carry no body; only what the file states is stored.
 */
const { parseXml, toText, toIsoDate, canonicalUrl, asArray, pick, ParseError } = require('./util');

const PARSER_VERSION = 'sitemap@1';

function parse(text, { url, maxItems = 500 } = {}) {
    const doc = parseXml(text);
    const items = [];
    let skipped = 0;
    const seen = new Set();
    const push = (it) => {
        if (!it || seen.has(it.identity) || items.length >= maxItems) { skipped++; return; }
        seen.add(it.identity);
        items.push(it);
    };
    if (doc.urlset) {
        for (const u of asArray(doc.urlset.url)) {
            const loc = u && typeof u === 'object' ? canonicalUrl(pick(u, 'loc')) : null;
            if (!loc) { skipped++; continue; }
            const news = u['news:news'] && (Array.isArray(u['news:news']) ? u['news:news'][0] : u['news:news']);
            push({
                identity: loc,
                kind: 'url',
                canonical_url: loc,
                title: news ? toText(pick(news, 'news:title'), 500) : null,
                summary: null,
                authors: [],
                published_at: news ? toIsoDate(pick(news, 'news:publication_date')) : null,
                updated_at: toIsoDate(pick(u, 'lastmod')),
                fields: {
                    changefreq: toText(pick(u, 'changefreq'), 20),
                    priority: /^(0(\.\d+)?|1(\.0+)?)$/.test(String(pick(u, 'priority') ?? '')) ? Number(pick(u, 'priority')) : null,
                    publication: news && news['news:publication'] ? toText(pick(news['news:publication'], 'news:name'), 200) : null,
                },
            });
        }
        return { items, skipped, meta: { format: 'urlset' } };
    }
    if (doc.sitemapindex) {
        for (const s of asArray(doc.sitemapindex.sitemap)) {
            const loc = s && typeof s === 'object' ? canonicalUrl(pick(s, 'loc')) : null;
            if (!loc) { skipped++; continue; }
            push({
                identity: loc, kind: 'sitemap', canonical_url: loc, title: null, summary: null, authors: [],
                published_at: null, updated_at: toIsoDate(pick(s, 'lastmod')), fields: {},
            });
        }
        return { items, skipped, meta: { format: 'sitemapindex', base: url } };
    }
    throw new ParseError('not a sitemap (<urlset> or <sitemapindex>)');
}

module.exports = { parse, PARSER_VERSION };
