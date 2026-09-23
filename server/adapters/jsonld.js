'use strict';
/**
 * JSON-LD (schema.org) embedded in HTML pages → items of kind product | offer | review | article.
 *
 * Types read: Product, Offer, AggregateOffer, Review, NewsArticle, BlogPosting (and Article and
 * its news subtypes). Values are copied as the page states them: prices stay the strings the page
 * gave, ratings are the page's own numbers, availability is the schema.org term. Nothing is
 * computed, averaged or defaulted; a missing price is null. Embedded reviews keep author, rating
 * and date only (review text belongs to its author).
 *
 * A page without any readable JSON-LD block is a parse error: the source promised structured data
 * and did not deliver it, and the run must say so instead of producing nothing silently.
 */
const crypto = require('crypto');
const { toText, toIsoDate, canonicalUrl, toId, asArray, ParseError } = require('./util');

const PARSER_VERSION = 'jsonld@1';
const ARTICLE_TYPES = new Set(['NewsArticle', 'BlogPosting', 'Article', 'ReportageNewsArticle', 'AnalysisNewsArticle', 'OpinionNewsArticle', 'BackgroundNewsArticle']);
const KIND = { Product: 'product', Offer: 'offer', AggregateOffer: 'offer', Review: 'review' };

function typesOf(node) {
    return asArray(node && node['@type']).map(t => String(t).replace(/^https?:\/\/schema\.org\//, ''));
}

function kindOf(node) {
    for (const t of typesOf(node)) {
        if (KIND[t]) return { kind: KIND[t], type: t };
        if (ARTICLE_TYPES.has(t)) return { kind: 'article', type: t };
    }
    return null;
}

function extractBlocks(html) {
    const blocks = [];
    const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json[^>]*>([\s\S]*?)<\/script\s*>/gi;
    let m;
    while ((m = re.exec(html)) && blocks.length < 50) blocks.push(m[1]);
    return blocks;
}

function flatten(value, out, depth = 0) {
    if (depth > 3 || value == null) return;
    if (Array.isArray(value)) { for (const v of value) flatten(v, out, depth + 1); return; }
    if (typeof value !== 'object') return;
    if (value['@graph']) flatten(value['@graph'], out, depth + 1);
    if (value['@type']) out.push(value);
}

const str = (v, max = 200) => (v == null || typeof v === 'object' ? null : toText(String(v), max));
const nameOf = (v) => (v == null ? null : typeof v === 'object' ? str(Array.isArray(v) ? (v[0] && v[0].name) : v.name) : str(v));
/** A number the page stated as a number or numeric string; anything else → null. */
const numeric = (v) => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim());
    return null;
};
/** A price exactly as written, if it is a plain decimal; else null. */
const priceOf = (v) => {
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())) return v.trim();
    return null;
};
const term = (v) => (typeof v === 'string' ? v.replace(/^https?:\/\/schema\.org\//, '').slice(0, 60) : null);
const imageOf = (v, base) => {
    const first = asArray(v)[0];
    return canonicalUrl(first && typeof first === 'object' ? first.url || first.contentUrl : first, base);
};

function offerFields(o, base) {
    if (!o || typeof o !== 'object') return null;
    return {
        type: typesOf(o)[0] || null,
        price: priceOf(o.price),
        low_price: priceOf(o.lowPrice),
        high_price: priceOf(o.highPrice),
        offer_count: numeric(o.offerCount),
        currency: typeof o.priceCurrency === 'string' && /^[A-Z]{3}$/.test(o.priceCurrency) ? o.priceCurrency : null,
        availability: term(o.availability),
        condition: term(o.itemCondition),
        valid_until: toIsoDate(o.priceValidUntil),
        url: canonicalUrl(o.url, base),
        seller: nameOf(o.seller),
    };
}

function ratingFields(r) {
    if (!r || typeof r !== 'object') return null;
    const out = {
        value: numeric(r.ratingValue), best: numeric(r.bestRating), worst: numeric(r.worstRating),
        count: numeric(r.ratingCount), review_count: numeric(r.reviewCount),
    };
    return out.value == null && out.count == null && out.review_count == null ? null : out;
}

function identityFor(node, url, pageUrl, type, ...keys) {
    const id = typeof node['@id'] === 'string' ? canonicalUrl(node['@id'], pageUrl) || toId(node['@id']) : null;
    if (id) return id;
    if (url && url !== pageUrl) return url;
    const key = keys.find(k => k);
    if (key) return `${pageUrl}#${type}:${crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 16)}`;
    return null;
}

function toItem(node, pageUrl, summaryMax) {
    const k = kindOf(node);
    if (!k) return null;
    const url = canonicalUrl(node.url, pageUrl);
    if (k.kind === 'product') {
        const sku = toId(node.sku, 100);
        const gtin = toId(node.gtin13 || node.gtin12 || node.gtin14 || node.gtin8 || node.gtin, 20);
        const name = str(node.name, 500);
        const identity = identityFor(node, url, pageUrl, 'Product', sku, gtin, name);
        if (!identity) return null;
        return {
            identity, kind: 'product', canonical_url: url || pageUrl,
            title: name, summary: toText(node.description, summaryMax), authors: [],
            published_at: null, updated_at: null,
            fields: {
                schema_type: k.type, sku, gtin, mpn: toId(node.mpn, 100), brand: nameOf(node.brand),
                image: imageOf(node.image, pageUrl),
                offers: asArray(node.offers).map(o => offerFields(o, pageUrl)).filter(Boolean).slice(0, 20),
                aggregate_rating: ratingFields(node.aggregateRating),
                reviews: asArray(node.review).slice(0, 10).map(r => (r && typeof r === 'object' ? {
                    author: nameOf(r.author), rating: ratingFields(r.reviewRating), date: toIsoDate(r.datePublished),
                } : null)).filter(Boolean),
            },
        };
    }
    if (k.kind === 'offer') {
        const f = offerFields(node, pageUrl);
        const itemName = nameOf(node.itemOffered) || str(node.name, 500);
        const identity = identityFor(node, url, pageUrl, k.type, toId(node.sku, 100), itemName && `${itemName}|${f.price}|${f.currency}`);
        if (!identity) return null;
        return {
            identity, kind: 'offer', canonical_url: url || pageUrl, title: itemName, summary: toText(node.description, summaryMax),
            authors: [], published_at: null, updated_at: null, fields: { schema_type: k.type, ...f },
        };
    }
    if (k.kind === 'review') {
        const title = str(node.name, 500) || (nameOf(node.itemReviewed) ? `Review: ${nameOf(node.itemReviewed)}` : null);
        const authors = asArray(node.author).map(nameOf).filter(Boolean).slice(0, 10);
        const identity = identityFor(node, url, pageUrl, 'Review', `${nameOf(node.itemReviewed)}|${authors.join(',')}|${node.datePublished || ''}`);
        if (!identity) return null;
        return {
            identity, kind: 'review', canonical_url: url || pageUrl, title,
            summary: toText(node.reviewBody || node.description, summaryMax), authors,
            published_at: toIsoDate(node.datePublished), updated_at: toIsoDate(node.dateModified),
            fields: {
                schema_type: 'Review', item_reviewed: nameOf(node.itemReviewed),
                item_reviewed_type: node.itemReviewed && typeof node.itemReviewed === 'object' ? typesOf(node.itemReviewed)[0] || null : null,
                rating: ratingFields(node.reviewRating), publisher: nameOf(node.publisher),
            },
        };
    }
    // article
    const headline = str(node.headline || node.name, 500);
    const identity = identityFor(node, url, pageUrl, k.type, headline);
    if (!identity) return null;
    return {
        identity, kind: 'article', canonical_url: url || pageUrl, title: headline,
        summary: toText(node.description, summaryMax),
        authors: asArray(node.author).map(nameOf).filter(Boolean).slice(0, 20),
        published_at: toIsoDate(node.datePublished), updated_at: toIsoDate(node.dateModified),
        fields: {
            schema_type: k.type, publisher: nameOf(node.publisher), section: str(node.articleSection, 100),
            image: imageOf(node.image, pageUrl), language: str(node.inLanguage, 20),
        },
    };
}

function parse(text, { url, summaryMax = 1000, maxItems = 500 } = {}) {
    const blocks = extractBlocks(text);
    if (!blocks.length) throw new ParseError('no application/ld+json block on the page');
    const nodes = [];
    let bad = 0;
    for (const b of blocks) {
        try { flatten(JSON.parse(b.trim()), nodes); } catch { bad++; }
    }
    if (bad === blocks.length) throw new ParseError('no JSON-LD block is valid JSON');
    const items = [];
    let skipped = bad;
    const seen = new Set();
    for (const n of nodes) {
        if (!kindOf(n)) continue;   // Organization, BreadcrumbList… are not items
        const it = toItem(n, url, summaryMax);
        if (!it || seen.has(it.identity) || items.length >= maxItems) { skipped++; continue; }
        seen.add(it.identity);
        items.push(it);
    }
    return { items, skipped, meta: { format: 'jsonld', blocks: blocks.length } };
}

module.exports = { parse, PARSER_VERSION, extractBlocks };
