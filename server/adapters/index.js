'use strict';
/**
 * Adapter registry: source type → parser. `manual` sources have no fetcher; their items are
 * entered through the API with the evidence URL they came from.
 */
const feed = require('./feed');
const sitemap = require('./sitemap');
const jsonld = require('./jsonld');
const api = require('./api');

const ADAPTERS = {
    rss: { parse: feed.parse, version: feed.PARSER_VERSION, accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1' },
    atom: { parse: feed.parse, version: feed.PARSER_VERSION, accept: 'application/atom+xml, application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1' },
    sitemap: { parse: sitemap.parse, version: sitemap.PARSER_VERSION, accept: 'application/xml, text/xml;q=0.9, */*;q=0.1' },
    jsonld: { parse: jsonld.parse, version: jsonld.PARSER_VERSION, accept: 'text/html, application/xhtml+xml;q=0.9, */*;q=0.1' },
    api: { parse: api.parse, version: api.PARSER_VERSION, accept: 'application/json, application/xml;q=0.9, */*;q=0.1' },
};

const MANUAL_VERSION = 'manual@1';

module.exports = { ADAPTERS, MANUAL_VERSION, checkApiMapping: api.checkMapping };
