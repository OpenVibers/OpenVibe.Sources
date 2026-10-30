'use strict';
/**
 * A delta index: a text file that lists gzipped JSONL parts (Open Food Facts publishes one such index at
 * https://static.openfoodfacts.org/data/delta/index.txt). A bulk source with `resolver: "off-delta"` reads the
 * index, then only the parts it has not finished; the cursor is the last completed part plus, while a part is
 * still being read, that part's name and row offset. Parts are named `..._<start>_<end>.json.gz`; the end
 * timestamp gives their order, oldest first, so a run works forward and never re-reads an older part.
 *
 * The full Open Food Facts export is one gzip stream: resuming inside it would mean decompressing it from the
 * start again, so this resolver uses only the official deltas. Every delta is itself gzip, so a run that stops
 * at the row limit records its row offset in that one part and the next run skips those rows while streaming it.
 */
const { ParseError } = require('./util');

const PARSER_VERSION = 'off-delta@1';
const STATE_NAME = 'delta.cursor';
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl?\.gz$/;
const RANGE_RE = /_(\d{10})_(\d{10})\.jsonl?\.gz$/;

/** The index's non-empty lines → its parts, oldest first (by the end timestamp in the name). */
function parseIndex(text, indexUrl) {
    const files = [];
    const seen = new Set();
    for (const raw of String(text == null ? '' : text).split(/\r?\n/)) {
        const name = raw.trim();
        if (!name) continue;
        if (!FILE_RE.test(name) || name.includes('..') || name.includes('/') || name.includes('\\')) {
            throw new ParseError(`delta index names an unexpected file: ${name.slice(0, 200)}`);
        }
        const m = RANGE_RE.exec(name);
        if (!m) throw new ParseError(`delta file name has no start/end timestamp: ${name.slice(0, 200)}`);
        const start = Number(m[1]);
        const end = Number(m[2]);
        if (!(end > start) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) throw new ParseError(`delta file name has a bad time range: ${name.slice(0, 200)}`);
        if (seen.has(name)) throw new ParseError(`delta index repeats ${name.slice(0, 200)}`);
        seen.add(name);
        files.push({ name, start, end, url: new URL(name, indexUrl).toString() });
    }
    if (!files.length) throw new ParseError('delta index lists no files');
    files.sort((a, b) => (a.end - b.end) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return files;
}

/** The stored cursor JSON → the shape the resolver reads; a corrupt value starts from the oldest part again. */
function readState(value) {
    let o = null;
    try { o = value ? JSON.parse(value) : null; } catch { o = null; }
    const state = o && typeof o === 'object' ? o : {};
    return {
        seen: typeof state.seen === 'string' && state.seen ? state.seen : null,
        seen_end: Number.isSafeInteger(Number(state.seen_end)) && Number(state.seen_end) > 0 ? Number(state.seen_end) : 0,
        current: typeof state.current === 'string' && state.current ? state.current : null,
        offset: Number.isSafeInteger(Number(state.offset)) && Number(state.offset) > 0 ? Number(state.offset) : 0,
    };
}

/** The parts this run should read, oldest first: the unfinished one first, then every later unseen one. */
function nextFiles(files, state) {
    const seenEnd = state.seen_end || 0;
    const seenName = state.seen || '';
    const after = (f) => f.end > seenEnd || (f.end === seenEnd && f.name > seenName);
    let list = files.filter(after);
    if (state.current) {
        const current = files.find((f) => f.name === state.current);
        if (current && after(current)) list = [current, ...list.filter((f) => f.name !== current.name)];
    }
    return list.sort((a, b) => (a.end - b.end) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

module.exports = { parseIndex, readState, nextFiles, PARSER_VERSION, STATE_NAME, FILE_RE, RANGE_RE };
