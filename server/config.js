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
    return {
        port,
        host: env.HOST || '127.0.0.1',
        nodeEnv,
        isProduction,
        serviceId: 'sources',
        baseUrl: strip(env.BASE_URL || (isProduction ? 'https://sources.openvibe.network' : `http://localhost:${port}`)),

        networkUrl: strip(env.OV_NETWORK_URL || 'https://openvibe.network'),
        networkInternalUrl: strip(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
        issuer: strip(env.OV_NETWORK_ISSUER || env.OV_NETWORK_URL || 'https://openvibe.network'),
        networkPublicKey: env.OV_NETWORK_PUBLIC_KEY ? env.OV_NETWORK_PUBLIC_KEY.replace(/\\n/g, '\n') : null,
        audience: 'openvibe.sources',
        oauth: {
            clientId: env.OV_OAUTH_CLIENT_ID || 'sources',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
        },

        dbPath: env.SOURCES_DB_PATH || './data/sources.db',

        events: {
            url: strip(env.EVENTS_URL || ''),
            relayIntervalMs: int(env.EVENTS_RELAY_INTERVAL_MS, 2000),
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
            userAgent: env.SOURCES_USER_AGENT || `OpenVibeSources/${pkg.version} (+https://sources.openvibe.network; Contact@OpenVibe.Network)`,
            // Product token matched against robots.txt User-agent lines.
            robotsAgent: env.SOURCES_ROBOTS_AGENT || 'OpenVibeSources',
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
        items: {
            maxPerFetch: int(env.SOURCES_MAX_ITEMS_PER_FETCH, 500),
            summaryMax: 1000,
        },
        secrets: env,
    };
}

module.exports = { load };
