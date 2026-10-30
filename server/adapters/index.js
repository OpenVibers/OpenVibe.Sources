'use strict';
/**
 * Adapter registry: source type → parser. `manual` sources have no fetcher; their items are
 * entered through the API with the evidence URL they came from. `bulk` streams one dataset file and
 * `hn-whoishiring` walks several JSON documents (a resolver), so both have their own ingest path.
 */
const feed = require('./feed');
const sitemap = require('./sitemap');
const jsonld = require('./jsonld');
const api = require('./api');
const bulk = require('./bulk');
const hn = require('./hn');

const ADAPTERS = {
    rss: { parse: feed.parse, version: feed.PARSER_VERSION, accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1' },
    atom: { parse: feed.parse, version: feed.PARSER_VERSION, accept: 'application/atom+xml, application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1' },
    sitemap: { parse: sitemap.parse, version: sitemap.PARSER_VERSION, accept: 'application/xml, text/xml;q=0.9, */*;q=0.1' },
    jsonld: { parse: jsonld.parse, version: jsonld.PARSER_VERSION, accept: 'text/html, application/xhtml+xml;q=0.9, */*;q=0.1' },
    api: { parse: api.parse, version: api.PARSER_VERSION, accept: 'application/json, application/xml;q=0.9, text/tab-separated-values;q=0.9, text/plain;q=0.8, */*;q=0.1' },
    bulk: {
        parse: null, version: bulk.PARSER_VERSION, createParser: bulk.createParser,
        accept: 'text/csv, text/tab-separated-values, application/x-ndjson, application/jsonl, application/json;q=0.9, application/gzip;q=0.9, */*;q=0.1',
    },
};

// A resolver reads several URLs of one API and returns the same { items, skipped, meta } an adapter's parse does.
const RESOLVERS = { 'hn-whoishiring': { resolve: hn.resolve, version: hn.PARSER_VERSION } };

const MANUAL_VERSION = 'manual@1';

module.exports = { ADAPTERS, RESOLVERS, MANUAL_VERSION, checkApiMapping: api.checkMapping };
