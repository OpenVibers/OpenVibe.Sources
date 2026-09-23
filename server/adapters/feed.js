'use strict';
/**
 * RSS 2.0, RSS 1.0 (RDF) and Atom 1.0 → items of kind `article`.
 *
 * Identity: the entry's guid/id, else its link. An entry with neither is skipped (counted), never
 * given a made-up identity. Summary is text only (HTML stripped) and capped: Sources keeps
 * metadata and short descriptions, not republishable full text.
 */
const { parseXml, toText, toIsoDate, canonicalUrl, toId, asArray, pick, ParseError } = require('./util');

const PARSER_VERSION = 'feed@1';

function atomLink(entry, base) {
    const links = asArray(entry.link);
    const alt = links.find(l => typeof l === 'object' && (!l['@_rel'] || l['@_rel'] === 'alternate') && l['@_href'])
        || links.find(l => typeof l === 'object' && l['@_href'])
        || links.find(l => typeof l === 'string');
    if (!alt) return null;
    return canonicalUrl(typeof alt === 'string' ? alt : alt['@_href'], base);
}

function authorsOf(list) {
    return asArray(list).map((a) => {
        if (a == null) return null;
        if (typeof a === 'object') return toText(a.name ?? a['#text'] ?? a.__cdata, 200);
        return toText(a, 200);
    }).filter(Boolean).slice(0, 20);
}

function categoriesOf(list) {
    return asArray(list).map((c) => {
        if (c == null) return null;
        if (typeof c === 'object') return toText(c['@_term'] ?? c['#text'] ?? c.__cdata, 100);
        return toText(c, 100);
    }).filter(Boolean).slice(0, 30);
}

function rssItem(it, base, summaryMax) {
    const guidNode = Array.isArray(it.guid) ? it.guid[0] : it.guid;
    const guid = toId(guidNode);
    const link = canonicalUrl(pick(it, 'link'), base);
    // RSS: a guid is a permalink unless isPermaLink="false".
    const guidIsPermalink = !(guidNode && typeof guidNode === 'object' && guidNode['@_isPermaLink'] === 'false');
    const url = link || (guid && guidIsPermalink ? canonicalUrl(guid) : null);
    const identity = guid || url;
    if (!identity) return null;
    const enclosure = asArray(it.enclosure).find(e => e && typeof e === 'object' && e['@_url']);
    return {
        identity,
        kind: 'article',
        canonical_url: url,
        title: toText(pick(it, 'title'), 500),
        summary: toText(pick(it, 'description', 'content:encoded'), summaryMax),
        authors: authorsOf(it['dc:creator'] ?? it.author),
        published_at: toIsoDate(pick(it, 'pubDate', 'dc:date')),
        updated_at: toIsoDate(pick(it, 'atom:updated', 'dc:modified')),
        fields: {
            categories: categoriesOf(it.category ?? it['dc:subject']),
            enclosure: enclosure ? { url: canonicalUrl(enclosure['@_url'], base), type: toId(enclosure['@_type'], 100), length: /^\d{1,15}$/.test(String(enclosure['@_length'] || '')) ? Number(enclosure['@_length']) : null } : null,
            comments_url: canonicalUrl(pick(it, 'comments'), base),
        },
    };
}

function atomEntry(e, base, summaryMax) {
    const id = toId(pick(e, 'id'));
    const url = atomLink(e, base);
    const identity = id || url;
    if (!identity) return null;
    return {
        identity,
        kind: 'article',
        canonical_url: url,
        title: toText(pick(e, 'title'), 500),
        summary: toText(pick(e, 'summary', 'content'), summaryMax),
        authors: authorsOf(e.author),
        published_at: toIsoDate(pick(e, 'published', 'issued')),
        updated_at: toIsoDate(pick(e, 'updated', 'modified')),
        fields: { categories: categoriesOf(e.category) },
    };
}

/** parse(text, { url, summaryMax, maxItems }) → { items, skipped, meta } or throws ParseError. */
function parse(text, { url, summaryMax = 1000, maxItems = 500 } = {}) {
    const doc = parseXml(text);
    let raw = [];
    let meta = {};
    let make;
    if (doc.rss && doc.rss.channel) {
        const ch = Array.isArray(doc.rss.channel) ? doc.rss.channel[0] : doc.rss.channel;
        raw = asArray(ch.item);
        meta = { format: 'rss2', title: toText(pick(ch, 'title'), 300), link: canonicalUrl(pick(ch, 'link'), url) };
        make = (it) => rssItem(it, url, summaryMax);
    } else if (doc['rdf:RDF']) {
        const rdf = doc['rdf:RDF'];
        raw = asArray(rdf.item);
        const ch = Array.isArray(rdf.channel) ? rdf.channel[0] : rdf.channel;
        meta = { format: 'rss1', title: ch ? toText(pick(ch, 'title'), 300) : null };
        make = (it) => rssItem({ ...it, guid: it['@_rdf:about'] ? { '#text': it['@_rdf:about'] } : undefined }, url, summaryMax);
    } else if (doc.feed) {
        const feed = doc.feed;
        raw = asArray(feed.entry);
        meta = { format: 'atom', title: toText(pick(feed, 'title'), 300), link: atomLink(feed, url) };
        make = (e) => atomEntry(e, url, summaryMax);
    } else {
        throw new ParseError('not an RSS or Atom document');
    }
    const items = [];
    let skipped = 0;
    const seen = new Set();
    for (const r of raw) {
        if (items.length >= maxItems) { skipped++; continue; }
        const it = r && typeof r === 'object' ? make(r) : null;
        if (!it || seen.has(it.identity)) { skipped++; continue; }
        seen.add(it.identity);
        items.push(it);
    }
    return { items, skipped, meta };
}

module.exports = { parse, PARSER_VERSION };
