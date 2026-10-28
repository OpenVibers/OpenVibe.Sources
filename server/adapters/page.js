'use strict';
/**
 * What a crawled HTML page says about itself for machines: its robots directives (<meta name="robots"> and our own
 * product token's <meta>, plus X-Robots-Tag), its canonical URL, its links, and the metadata it publishes for search
 * engines and link previews (title, description, Open Graph, article times, language).
 *
 * A crawl reads the page's schema.org JSON-LD first (adapters/jsonld.js); a source that does not require structured
 * data keeps a page without it as one `page` item built from this metadata. Nothing here reads the page's prose: the
 * summary is the description the page wrote for search results, never its body.
 */
const { toText, toIsoDate, canonicalUrl, decodeEntities } = require('./util');
const { agentTokens } = require('../robots');

const PARSER_VERSION = 'page@1';
const MAX_LINKS = 1000;

/** The attributes of one start tag, names lower-cased, values decoded. */
function attrs(tag) {
    const out = {};
    const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    const body = tag.replace(/^<\s*[a-z0-9-]+/i, '').replace(/\/?>$/, '');
    let m;
    while ((m = re.exec(body))) {
        const name = m[1].toLowerCase();
        if (!(name in out)) out[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
    }
    return out;
}

function tags(html, name) {
    const re = new RegExp(`<${name}\\b[^>]*>`, 'gi');
    return html.match(re) || [];
}

/** noindex / nofollow from a robots directive list ("noindex, nofollow", "none"). */
function directives(value) {
    const d = String(value || '').toLowerCase().split(',').map(s => s.trim());
    return { noindex: d.includes('noindex') || d.includes('none'), nofollow: d.includes('nofollow') || d.includes('none') };
}

/**
 * X-Robots-Tag: "noindex", "noindex, nofollow", or scoped to one crawler ("otherbot: noindex"). A directive scoped to
 * another crawler does not apply to us; one scoped to any of our product tokens does.
 */
function headerDirectives(header, agent) {
    const out = { noindex: false, nofollow: false };
    for (const line of [].concat(header || [])) {
        let value = String(line);
        const m = /^\s*([a-z0-9_-]+)\s*:\s*(.*)$/i.exec(value);
        if (m && !['unavailable_after', 'max-snippet', 'max-image-preview', 'max-video-preview'].includes(m[1].toLowerCase())) {
            if (!agentTokens(agent).includes(m[1].toLowerCase())) continue;
            value = m[2];
        }
        const d = directives(value);
        out.noindex = out.noindex || d.noindex;
        out.nofollow = out.nofollow || d.nofollow;
    }
    return out;
}

/**
 * read(html, { url, agent, headers, links }) → { noindex, nofollow, canonical, base, title, description, image, site_name,
 * og_type, language, published_at, updated_at, author, links: [absolute urls] }
 */
function read(html, { url, agent = 'OpenVibeBot,OpenVibeSources', headers = {}, links = false } = {}) {
    const head = html.slice(0, 512 * 1024);
    const meta = {};
    let noindex = false;
    let nofollow = false;
    const tokens = agentTokens(agent);
    for (const t of tags(head, 'meta')) {
        const a = attrs(t);
        const key = (a.name || a.property || '').toLowerCase();
        if (!key || a.content == null) continue;
        if (key === 'robots' || tokens.includes(key)) {
            const d = directives(a.content);
            noindex = noindex || d.noindex;
            nofollow = nofollow || d.nofollow;
            continue;
        }
        if (!(key in meta)) meta[key] = a.content;
    }
    const h = headerDirectives(headers['x-robots-tag'], agent);
    noindex = noindex || h.noindex;
    nofollow = nofollow || h.nofollow;

    let base = url;
    const baseTag = tags(head, 'base').map(attrs).find(a => a.href);
    if (baseTag) base = canonicalUrl(baseTag.href, url) || url;
    let canonical = null;
    for (const t of tags(head, 'link')) {
        const a = attrs(t);
        if (String(a.rel || '').toLowerCase().split(/\s+/).includes('canonical') && a.href) { canonical = canonicalUrl(a.href, base); break; }
    }
    const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head);
    const htmlTag = tags(head, 'html')[0];
    const lang = htmlTag ? attrs(htmlTag).lang : null;

    const found = [];
    if (links && !nofollow) {
        const seen = new Set();
        for (const t of tags(html, 'a')) {
            if (found.length >= MAX_LINKS) break;
            const a = attrs(t);
            if (!a.href || String(a.rel || '').toLowerCase().split(/\s+/).includes('nofollow')) continue;
            const abs = canonicalUrl(a.href, base);
            if (abs && !seen.has(abs)) { seen.add(abs); found.push(abs); }
        }
    }

    return {
        noindex, nofollow, canonical, base,
        title: toText(meta['og:title'] || (titleTag ? titleTag[1] : null), 500),
        description: toText(meta['og:description'] || meta.description, 1000),
        image: canonicalUrl(meta['og:image'] || meta['og:image:url'] || meta['twitter:image'], base),
        site_name: toText(meta['og:site_name'], 200),
        og_type: toText(meta['og:type'], 60),
        language: lang ? String(lang).slice(0, 20) : null,
        published_at: toIsoDate(meta['article:published_time']),
        updated_at: toIsoDate(meta['article:modified_time'] || meta['og:updated_time']),
        author: toText(meta.author || meta['article:author'], 200),
        links: found,
    };
}

/** The page as one item from its metadata (a source that does not require structured data); null without a title. */
function pageItem(meta, pageUrl, summaryMax = 1000) {
    if (!meta.title) return null;
    const url = meta.canonical || pageUrl;
    return {
        identity: url, kind: 'page', canonical_url: url,
        title: meta.title, summary: meta.description ? meta.description.slice(0, summaryMax) : null,
        authors: meta.author && !/^https?:/i.test(meta.author) ? [meta.author] : [],
        published_at: meta.published_at, updated_at: meta.updated_at,
        fields: { site_name: meta.site_name, image: meta.image, language: meta.language, og_type: meta.og_type },
    };
}

module.exports = { read, pageItem, attrs, headerDirectives, PARSER_VERSION };
