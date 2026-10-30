'use strict';
/**
 * The only way Sources reaches the internet: GET with an address guard (server/net/guard.js),
 * manual redirects re-checked hop by hop, conditional headers, one overall deadline covering
 * connect + headers + body, a byte cap applied to the decoded body, and no cookies.
 *
 *   fetchUrl(url, { headers, etag, lastModified, beforeHop(url) }) →
 *     { kind: 'response', status, headers, body (Buffer|null), finalUrl, bytes }
 *   or throws FetchError { code: timeout | too_large | address_refused | port_refused | bad_url |
 *     too_many_redirects | network | hop_refused, detail }
 */
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { GuardError } = require('./guard');

class FetchError extends Error {
    constructor(code, detail) { super(detail); this.code = code; }
}

function createFetcher({ guard, userAgent, timeoutMs = 20000, maxBytes = 5 * 1024 * 1024, maxRedirects = 5 }) {
    function once(url, headers, deadline, capBytes, limitMs = timeoutMs) {
        return new Promise((resolve, reject) => {
            const mod = url.protocol === 'https:' ? https : http;
            const remaining = deadline - Date.now();
            if (remaining <= 0) return reject(new FetchError('timeout', 'deadline passed'));
            let settled = false;
            const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
            const req = mod.request(url, {
                method: 'GET',
                headers,
                lookup: guard.lookup,
                agent: false,
                timeout: remaining,
            }, (res) => {
                const status = res.statusCode;
                if (status >= 300 && status < 400 && res.headers.location) {
                    res.resume();
                    return done(resolve, { redirect: res.headers.location, status, headers: res.headers });
                }
                const declared = Number(res.headers['content-length']);
                if (Number.isFinite(declared) && declared > capBytes && status === 200) {
                    req.destroy();
                    return done(reject, new FetchError('too_large', `content-length ${declared} exceeds ${capBytes} bytes`));
                }
                let stream = res;
                const enc = String(res.headers['content-encoding'] || '').trim().toLowerCase();
                if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
                else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
                else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
                const chunks = [];
                let bytes = 0;
                stream.on('data', (c) => {
                    bytes += c.length;
                    if (bytes > capBytes) {
                        req.destroy();
                        done(reject, new FetchError('too_large', `body exceeds ${capBytes} bytes`));
                        return;
                    }
                    chunks.push(c);
                });
                stream.on('end', () => done(resolve, { status, headers: res.headers, body: Buffer.concat(chunks), bytes }));
                stream.on('error', (err) => done(reject, new FetchError('network', `body: ${err.message}`)));
                res.on('aborted', () => done(reject, new FetchError('network', 'response aborted')));
            });
            const timer = setTimeout(() => {
                req.destroy();
                done(reject, new FetchError('timeout', `no complete response within ${limitMs} ms`));
            }, remaining);
            req.on('timeout', () => {
                req.destroy();
                done(reject, new FetchError('timeout', `no complete response within ${limitMs} ms`));
            });
            req.on('error', (err) => {
                if (err instanceof GuardError) return done(reject, new FetchError(err.code, err.message));
                done(reject, new FetchError('network', `${err.code || 'error'}: ${err.message}`));
            });
            req.end();
        });
    }

    async function fetchUrl(input, { headers = {}, etag = null, lastModified = null, beforeHop = null, capBytes = maxBytes, sensitiveHeaders = [], timeoutMs: ownTimeout = null } = {}) {
        // An api endpoint may set its own deadline (adapters/api.js `timeout_ms`): a city's open-data aggregate can
        // take a minute to compute.
        const limitMs = ownTimeout || timeoutMs;
        const deadline = Date.now() + limitMs;
        let url;
        try { url = guard.checkUrl(input); } catch (err) { throw new FetchError(err.code || 'bad_url', err.message); }
        const h = {
            'User-Agent': userAgent,
            Accept: headers.Accept || '*/*',
            'Accept-Encoding': 'gzip, deflate, br',
            ...headers,
        };
        if (etag) h['If-None-Match'] = etag;
        if (lastModified) h['If-Modified-Since'] = lastModified;
        for (let hop = 0; ; hop++) {
            const r = await once(url, h, deadline, capBytes, limitMs);
            if (!r.redirect) return { kind: 'response', status: r.status, headers: r.headers, body: r.body, bytes: r.bytes, finalUrl: url.toString() };
            if (hop >= maxRedirects) throw new FetchError('too_many_redirects', `more than ${maxRedirects} redirects`);
            let next;
            try { next = guard.checkUrl(new URL(r.redirect, url).toString()); } catch (err) { throw new FetchError(err.code || 'bad_url', `redirect: ${err.message}`); }
            if (beforeHop) {
                const verdict = await beforeHop(next);
                if (verdict && verdict.refuse) throw new FetchError('hop_refused', verdict.refuse);
            }
            // Conditional headers belong to the original resource only; credentials never leave
            // the origin they were configured for.
            delete h['If-None-Match'];
            delete h['If-Modified-Since'];
            if (next.origin !== url.origin) for (const name of sensitiveHeaders) delete h[name];
            url = next;
        }
    }

    /** A streamed GET: the same guard/redirect/deadline/cap, but the decoded bytes go to onChunk as they arrive. */
    function onceStream(url, headers, deadline, capBytes, limitMs, onChunk) {
        return new Promise((resolve, reject) => {
            const mod = url.protocol === 'https:' ? https : http;
            const remaining = deadline - Date.now();
            if (remaining <= 0) return reject(new FetchError('timeout', 'deadline passed'));
            let settled = false;
            let stopped = false;
            const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
            const fail = (err) => { if (!settled) { settled = true; clearTimeout(timer); req.destroy(); reject(err); } };
            const req = mod.request(url, {
                method: 'GET',
                headers,
                lookup: guard.lookup,
                agent: false,
                timeout: remaining,
            }, (res) => {
                const status = res.statusCode;
                if (status >= 300 && status < 400 && res.headers.location) {
                    res.resume();
                    return done(resolve, { redirect: res.headers.location, status, headers: res.headers });
                }
                // Non-200 answers (304, 429, 4xx/5xx) carry no dataset: read the headers and let ingest decide.
                if (status !== 200 && status !== 203) {
                    res.resume();
                    return done(resolve, { status, headers: res.headers, bytes: 0, finalUrl: url.toString(), stopped: false });
                }
                const declared = Number(res.headers['content-length']);
                if (Number.isFinite(declared) && declared > capBytes) {
                    res.resume();
                    return fail(new FetchError('too_large', `content-length ${declared} exceeds ${capBytes} bytes`));
                }
                let stream = res;
                const enc = String(res.headers['content-encoding'] || '').trim().toLowerCase();
                const type = String(res.headers['content-type'] || '').toLowerCase();
                if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
                else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
                else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
                // A dataset file may be served as application/gzip (or named .gz) without Content-Encoding.
                else if (/gzip/.test(type) || /\.gz(?:\?|$)/i.test(url.pathname + url.search)) stream = res.pipe(zlib.createGunzip());
                let bytes = 0;
                stream.on('data', (chunk) => {
                    if (settled) return;
                    bytes += chunk.length;
                    if (bytes > capBytes) return fail(new FetchError('too_large', `body exceeds ${capBytes} bytes`));
                    let more = true;
                    try { more = onChunk(chunk); } catch (err) { return fail(err); }
                    if (more === false) {
                        stopped = true;
                        done(resolve, { status, headers: res.headers, bytes, finalUrl: url.toString(), stopped: true });
                        res.destroy();
                        stream.destroy();
                        req.destroy();
                    }
                });
                stream.on('end', () => done(resolve, { status, headers: res.headers, bytes, finalUrl: url.toString(), stopped }));
                stream.on('error', (err) => fail(new FetchError('network', `body: ${err.message}`)));
                res.on('aborted', () => { if (!stopped) fail(new FetchError('network', 'response aborted')); });
            });
            const timer = setTimeout(() => {
                req.destroy();
                done(reject, new FetchError('timeout', `no complete response within ${limitMs} ms`));
            }, remaining);
            req.on('timeout', () => {
                req.destroy();
                done(reject, new FetchError('timeout', `no complete response within ${limitMs} ms`));
            });
            req.on('error', (err) => {
                if (err instanceof GuardError) return done(reject, new FetchError(err.code, err.message));
                done(reject, new FetchError('network', `${err.code || 'error'}: ${err.message}`));
            });
            req.end();
        });
    }

    /**
     * Stream one body to `onChunk(buffer)`. Return false from onChunk to stop early (the row limit): the request
     * is destroyed and the promise resolves with `stopped: true`, so a multi-GB file is never downloaded whole.
     */
    async function streamUrl(input, { headers = {}, beforeHop = null, capBytes = maxBytes, timeoutMs: ownTimeout = null } = {}, onChunk) {
        if (typeof onChunk !== 'function') throw new TypeError('streamUrl needs onChunk');
        const limitMs = ownTimeout || timeoutMs;
        const deadline = Date.now() + limitMs;
        let url;
        try { url = guard.checkUrl(input); } catch (err) { throw new FetchError(err.code || 'bad_url', err.message); }
        const h = {
            'User-Agent': userAgent,
            Accept: headers.Accept || '*/*',
            'Accept-Encoding': 'gzip, deflate, br',
            ...headers,
        };
        for (let hop = 0; ; hop++) {
            const r = await onceStream(url, h, deadline, capBytes, limitMs, onChunk);
            if (!r.redirect) return { kind: 'response', status: r.status, headers: r.headers, body: null, bytes: r.bytes, stopped: r.stopped, finalUrl: url.toString() };
            if (hop >= maxRedirects) throw new FetchError('too_many_redirects', `more than ${maxRedirects} redirects`);
            let next;
            try { next = guard.checkUrl(new URL(r.redirect, url).toString()); } catch (err) { throw new FetchError(err.code || 'bad_url', `redirect: ${err.message}`); }
            if (beforeHop) {
                const verdict = await beforeHop(next);
                if (verdict && verdict.refuse) throw new FetchError('hop_refused', verdict.refuse);
            }
            if (next.origin !== url.origin) for (const name of ['Authorization']) delete h[name];
            url = next;
        }
    }

    return { fetchUrl, streamUrl };
}

module.exports = { createFetcher, FetchError };
