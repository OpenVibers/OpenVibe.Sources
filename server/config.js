'use strict';
/**
 * OpenVibe.Sources configuration. Everything comes from the environment (.env in development,
 * /etc/openvibe/sources.env in production); see .env.example for the documented list.
 *
 * load(env) is pure so tests can build a config without touching process.env. `env` is also kept
 * as config.secrets: a source's credential is read from it by environment-variable NAME at fetch
 * time and never stored, logged or returned.
 */
const pkg = require('../package.json');

const int = (v, d) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : d;
};
const list = (v, d) => (v == null || v === '' ? d : String(v).split(',').map(s => s.trim()).filter(Boolean));
const strip = (v) => String(v || '').replace(/\/$/, '');

function load(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 4720);
    const networkUrl = strip(env.OV_NETWORK_URL || 'https://openvibe.network');
    const networkInternalUrl = strip(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000');
    // The JWKS the SDK's client (openvibe-sdk/auth jwksClient) fetches, caches and keeps fresh; one URL,
    // since the SDK keeps one client per URL. Defaults to Network's internal JWKS.
    const jwksUrl = strip(env.OV_NETWORK_JWKS_URL || `${networkInternalUrl}/api/.well-known/jwks`);
    const baseUrl = strip(env.BASE_URL || (isProduction ? 'https://sources.openvibe.network' : `http://localhost:${port}`));
    return {
        port,
        host: env.HOST || '127.0.0.1',
        nodeEnv,
        isProduction,
        serviceId: 'sources',
        baseUrl,

        networkUrl,
        networkInternalUrl,
        jwksUrl,
        issuer: strip(env.OV_NETWORK_ISSUER || env.OV_NETWORK_URL || 'https://openvibe.network'),
        audience: 'openvibe.sources',
        // Per-actor limits (server/api/actor-limits.js, roadmap WS-R task 4): the API reads one app or
        // module may make per minute and per hour. Writes set their own numbers there.
        limits: {
            minute: Math.max(1, int(env.SOURCES_LIMITS_MINUTE, 120)),
            hour: Math.max(1, int(env.SOURCES_LIMITS_HOUR, 3000)),
        },
        oauth: {
            clientId: env.OV_OAUTH_CLIENT_ID || 'sources',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
            // The Network OAuth client `sources` must be registered with this exact redirect URI.
            redirectUri: strip(env.OV_OAUTH_REDIRECT_URI || `${baseUrl}/merchant/callback`),
            scope: env.OV_OAUTH_SCOPE || 'profile',
        },
        cookies: {
            // A first-party session cookie; Secure everywhere except local tests/development over http.
            secure: env.SOURCES_COOKIE_SECURE != null ? env.SOURCES_COOKIE_SECURE === '1' : isProduction,
        },

        // Merchant opt-in (server/merchant.js): proof checks, the session form secret, and the shape of the source
        // created only after verification. A sitemap becomes a crawl; a product feed uses the feed adapter.
        merchant: {
            pendingDays: Math.max(1, int(env.SOURCES_MERCHANT_PENDING_DAYS, 14)),
            // Pending claims are checked again on this cadence; 0 turns the worker pass off (tests).
            recheckIntervalMs: Math.max(0, int(env.SOURCES_MERCHANT_RECHECK_MS, 10 * 60 * 1000)),
            metaMaxBytes: Math.min(5 * 1024 * 1024, Math.max(1024, int(env.SOURCES_MERCHANT_META_MAX_BYTES, 1024 * 1024))),
            metaTimeoutMs: Math.min(120000, Math.max(1000, int(env.SOURCES_MERCHANT_META_TIMEOUT_MS, 10000))),
            dnsServers: list(env.SOURCES_MERCHANT_DNS_SERVERS, []),
            // CSRF/state HMAC key. Production should set SOURCES_SESSION_SECRET (or shares OV_OAUTH_CLIENT_SECRET).
            sessionSecret: env.SOURCES_SESSION_SECRET || env.OV_OAUTH_CLIENT_SECRET || 'sources-merchant-development',
            crawlMinIntervalMs: Math.min(86400000, Math.max(0, int(env.SOURCES_MERCHANT_CRAWL_MIN_INTERVAL_MS, 1000))),
            feedMinIntervalMs: Math.min(86400000, Math.max(0, int(env.SOURCES_MERCHANT_FEED_MIN_INTERVAL_MS, 60000))),
            pollIntervalSec: Math.min(7 * 86400, Math.max(1, int(env.SOURCES_MERCHANT_POLL_INTERVAL_SEC, 3600))),
            crawlStaleAfterSec: Math.min(90 * 86400, Math.max(1, int(env.SOURCES_MERCHANT_CRAWL_STALE_AFTER_SEC, 86400))),
            feedStaleAfterSec: Math.min(90 * 86400, Math.max(1, int(env.SOURCES_MERCHANT_FEED_STALE_AFTER_SEC, 10800))),
            maxItems: Math.min(12000, Math.max(1, int(env.SOURCES_MERCHANT_MAX_ITEMS, 1000))),
            crawlMaxPages: Math.min(200000, Math.max(1, int(env.SOURCES_MERCHANT_MAX_PAGES, 5000))),
            crawlPagesPerRun: Math.min(1000, Math.max(1, int(env.SOURCES_MERCHANT_PAGES_PER_RUN, 100))),
            crawlRecrawlSec: Math.min(30 * 86400, Math.max(3600, int(env.SOURCES_MERCHANT_RECRAWL_SEC, 86400))),
        },

        // PostgreSQL (ADR-035): DATABASE_URL serves (PgBouncer), DATABASE_DIRECT_URL migrates (owner role).
        db: { url: env.DATABASE_URL || '', directUrl: env.DATABASE_DIRECT_URL || '' },

        events: {
            url: strip(env.EVENTS_URL || ''),
            relayIntervalMs: int(env.EVENTS_RELAY_INTERVAL_MS, 2000),
            // The account-data consumer (POST /internal/events): the signing secret Network's deliveries use. Unset:
            // the route is off and Network's account export/deletion does not wait for Sources.
            secret: strip(env.SOURCES_EVENTS_SECRET || ''),
        },

        // Ingestion
        worker: {
            enabled: env.SOURCES_WORKER !== 'off',
            tickMs: int(env.SOURCES_TICK_MS, 5000),
            maxConcurrent: int(env.SOURCES_MAX_CONCURRENT, 4),
            // Longest wait between polls of a failing source (exponential backoff cap).
            maxBackoffMs: int(env.SOURCES_MAX_BACKOFF_MS, 6 * 3600 * 1000),
        },
        fetch: {
            // ADR 0007: the compatible-form string, fixed. robots.txt groups for either product token apply.
            userAgent: env.SOURCES_USER_AGENT || 'Mozilla/5.0 (compatible; OpenVibeBot/1.0; +https://openvibe.network/bot)',
            // Product tokens (comma list) matched against robots.txt User-agent lines, robots meta names and X-Robots-Tag.
            robotsAgent: env.SOURCES_ROBOTS_AGENT || 'OpenVibeBot,OpenVibeSources',
            timeoutMs: int(env.SOURCES_FETCH_TIMEOUT_MS, 20000),
            maxBytes: int(env.SOURCES_MAX_BYTES, 5 * 1024 * 1024),
            maxRedirects: int(env.SOURCES_MAX_REDIRECTS, 5),
            robotsMaxBytes: 512 * 1024,
            robotsTtlMs: int(env.SOURCES_ROBOTS_TTL_MS, 24 * 3600 * 1000),
            // Minimum gap between any two requests to one host, whatever the sources say.
            hostMinIntervalMs: int(env.SOURCES_HOST_MIN_INTERVAL_MS, 1000),
            allowedPorts: list(env.SOURCES_ALLOWED_PORTS, ['80', '443']).map(Number),
            // Exact hostnames/IPs that may resolve to private or loopback addresses (tests and
            // deliberate on-host sources only). Empty in production.
            allowPrivateHosts: list(env.SOURCES_ALLOW_PRIVATE_HOSTS, []),
        },
        // Crawl sources (server/crawl.js): how long one run may take, how many crawl at once (each holds a worker slot
        // for its whole run, so feeds always keep the rest), sitemap limits, and how soon a run follows one that left
        // pages due.
        crawl: {
            runMs: int(env.SOURCES_CRAWL_RUN_MS, 15 * 60 * 1000),
            maxConcurrent: int(env.SOURCES_MAX_CONCURRENT_CRAWLS, 2),
            soonMs: int(env.SOURCES_CRAWL_SOON_MS, 60 * 1000),
            sitemapMaxBytes: int(env.SOURCES_SITEMAP_MAX_BYTES, 50 * 1024 * 1024),
            sitemapMaxUrls: 50000,
            maxSitemaps: 1000,
        },
        items: {
            // The ceiling on any one source's max_items. Each source still keeps its own (most are 200 or less); 12000
            // lets sec-company-tickers take SEC's whole ticker list (about 10,450 rows) in its one daily request.
            maxPerFetch: int(env.SOURCES_MAX_ITEMS_PER_FETCH, 12000),
            summaryMax: 1000,
        },
        secrets: env,
    };
}

module.exports = { load };
