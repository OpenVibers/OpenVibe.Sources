'use strict';
/**
 * Bulk datasets: one dataset file per source, read as a stream, never loaded whole.
 *
 *   { "url": "https://static.example.org/products.csv.gz", "format": "csv",
 *     "item_kind": "product", "max_bytes": 2147483648, "max_rows": 12000,
 *     "fields": { "identity": "code", "url": "url", "title": "product_name" },
 *     "extra": { "brands": "brands", "energy_kcal": "energy-kcal_100g" } }
 *
 * The seed names the format — CSV, JSONL or TSV — and the field paths are the same as the api adapter's (a
 * column name for CSV/TSV, a dotted path inside the JSON object for JSONL). The parser takes chunks from the
 * fetcher and emits items as it goes; it stops the stream as soon as `max_rows` items are stored, so a 13 GB
 * dump costs a few MB of transfer and an ordinary amount of memory. `max_bytes` is the stream's own size cap.
 *
 * CSV follows RFC 4180 enough for published dumps: quoted fields, a quote inside a quoted field ("") and line
 * breaks inside quotes. TSV reads its header line the way api@1's tsv format does. JSONL is one JSON object per
 * non-empty line. A malformed row is counted and skipped, never invented.
 */
const { StringDecoder } = require('string_decoder');
const { mapRecord } = require('./api');
const { ParseError } = require('./util');

const PARSER_VERSION = 'bulk@1';

function createParser({ endpoint = {}, url, maxItems = 500, summaryMax = 1000 } = {}) {
    const format = endpoint.format || 'csv';
    const limit = Math.max(1, Math.min(Number(endpoint.max_rows) || 1000, Number(maxItems) || 500));
    const decoder = new StringDecoder('utf8');
    const items = [];
    const seen = new Set();
    let skipped = 0;
    let rows = 0;
    let stopped = false;

    // Line-oriented formats keep the tail of an incomplete line between chunks. CSV needs a small state machine
    // because a quoted field may contain commas and newlines.
    let pending = '';
    let header = null;
    let field = '';
    let row = [];
    let inQuotes = false;
    let quotePending = false;
    let first = true;

    function accept(rec) {
        if (stopped) return;
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)) { skipped++; return; }
        const index = rows++;
        const item = mapRecord(rec, rec, undefined, index, endpoint, url, summaryMax);
        if (!item) { skipped++; return; }
        if (seen.has(item.identity)) { skipped++; return; }
        seen.add(item.identity);
        items.push(item);
        if (items.length >= limit) stopped = true;
    }

    function headerOf(names, what) {
        const clean = names.map((n) => String(n == null ? '' : n).replace(/^\uFEFF/, '').trim());
        if (clean.some((n) => !n) || new Set(clean).size !== clean.length) throw new ParseError(`${what} header names must be present and distinct`);
        return clean;
    }

    function csvRow(cells) {
        if (first) {
            first = false;
            if (cells.length === 1 && cells[0].trim() === '') return;   // a blank first line
            header = headerOf(cells, 'csv');
            return;
        }
        if (cells.length === 1 && cells[0].trim() === '') return;
        if (cells.length !== header.length) { skipped++; return; }
        const rec = {};
        header.forEach((n, i) => { rec[n] = String(cells[i]).trim(); });
        accept(rec);
    }

    function csvWrite(text) {
        for (let i = 0; i < text.length; i++) {
            if (stopped) return;
            const ch = text[i];
            if (quotePending) {
                quotePending = false;
                if (ch === '"') { field += '"'; continue; }
                inQuotes = false;
                i--;                        // the close-quote's next character is an ordinary one
                continue;
            }
            if (inQuotes) {
                if (ch === '"') quotePending = true;
                else field += ch;
                continue;
            }
            if (ch === '"' && field === '') { inQuotes = true; continue; }
            if (ch === ',') { row.push(field); field = ''; continue; }
            if (ch === '\n') { row.push(field); field = ''; const cells = row; row = []; csvRow(cells); continue; }
            if (ch === '\r') continue;
            field += ch;
        }
    }

    function csvFinish() {
        if (quotePending) { quotePending = false; inQuotes = false; }
        if (inQuotes) { skipped++; return; }             // an unterminated quoted field is not a row
        if (!field.length && !row.length) return;
        row.push(field);
        field = '';
        const cells = row;
        row = [];
        csvRow(cells);
    }

    function line(text) {
        if (text === '') return;
        if (format === 'jsonl') {
            let rec;
            try { rec = JSON.parse(text); } catch { skipped++; return; }
            accept(rec);
            return;
        }
        // tsv
        const cells = text.split('\t');
        if (first) { first = false; header = headerOf(cells, 'tsv'); return; }
        if (cells.length !== header.length) { skipped++; return; }
        const rec = {};
        header.forEach((n, i) => { rec[n] = String(cells[i]).trim(); });
        accept(rec);
    }

    function lineWrite(text) {
        pending += text;
        const parts = pending.split('\n');
        pending = parts.pop();
        for (const part of parts) {
            line(part.endsWith('\r') ? part.slice(0, -1) : part);
            if (stopped) return;
        }
    }

    /** Feed one chunk; returns false when the row limit is reached and the fetcher should stop. */
    function write(chunk) {
        if (stopped) return false;
        const text = decoder.write(chunk);
        if (!text) return !stopped;
        if (format === 'csv') csvWrite(text);
        else lineWrite(text);
        return !stopped;
    }

    /** Finish the stream (not called when the row limit stopped it): flush the last line/row. */
    function end() {
        if (!stopped) {
            const tail = decoder.end();
            if (format === 'csv') { if (tail) csvWrite(tail); csvFinish(); }
            else { if (tail) lineWrite(tail); if (pending) line(pending.endsWith('\r') ? pending.slice(0, -1) : pending); }
        }
        return { items, skipped, meta: { format, rows, filtered: 0, capped: stopped } };
    }

    return { write, end, get full() { return stopped; }, get count() { return items.length; } };
}

module.exports = { createParser, PARSER_VERSION };
