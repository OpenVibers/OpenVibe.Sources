'use strict';
/**
 * `extract` on an rss/atom endpoint: fields read out of each item's own title or summary by a pattern, for a source
 * whose items state structured facts in prose (DealNews: 'Apply coupon code "UXBMXG9V" … Deal ends October 20 … at
 * Amazon'). An item that yields every `require`d field becomes `kind` with those fields; any other item is skipped
 * (it is another source's item: the plain feed keeps it). Nothing is inferred: a field is exactly the text the
 * pattern captured, or a date the item states.
 *
 *   endpoint.extract = {
 *     kind: 'coupon',
 *     require: ['code'],
 *     fields: {
 *       code:     { from: 'summary', pattern: '(?:coupon|promo) code "([A-Z0-9-]{4,32})"' },
 *       expires:  { from: 'summary', pattern: 'ends ([A-Z][a-z]+ \\d{1,2}(?:, \\d{4})?)', as: 'date' },
 *       merchant: { from: 'summary', pattern: 'Buy Now at ([A-Z][\\w&.\' -]{1,40}?)(?: Features|\\.|$)' },
 *     },
 *   }
 *
 * `as: 'date'` turns "October 20" or "October 20, 2026" into 2026-10-20: without a year, the first such day on or
 * after the item's own publication date (a sale that ends "October 20" published in December ends next year).
 */
const FROM = new Set(['title', 'summary']);
const NAME = /^[a-z][a-z0-9_]{0,40}$/;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** Why `extract` is not usable, or null. */
function check(x) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return 'extract must be an object';
    for (const k of Object.keys(x)) if (!['kind', 'require', 'fields'].includes(k)) return `extract.${k} is not known`;
    if (typeof x.kind !== 'string' || !NAME.test(x.kind)) return 'extract.kind is a short lower-case name';
    if (!x.fields || typeof x.fields !== 'object' || Array.isArray(x.fields)) return 'extract.fields is an object';
    const names = Object.keys(x.fields);
    if (!names.length || names.length > 12) return 'extract.fields has 1 to 12 fields';
    for (const n of names) {
        const f = x.fields[n];
        if (!NAME.test(n)) return `extract.fields.${n}: a field name is a short lower-case name`;
        if (!f || typeof f !== 'object') return `extract.fields.${n} is an object`;
        for (const k of Object.keys(f)) if (!['from', 'pattern', 'as'].includes(k)) return `extract.fields.${n}.${k} is not known`;
        if (!FROM.has(f.from)) return `extract.fields.${n}.from is title or summary`;
        if (typeof f.pattern !== 'string' || !f.pattern || f.pattern.length > 300) return `extract.fields.${n}.pattern is a regular expression of at most 300 characters`;
        try {
            if (!/\((?!\?)/.test(f.pattern)) return `extract.fields.${n}.pattern needs one capturing group`;
            new RegExp(f.pattern, 'i');
        } catch (e) { return `extract.fields.${n}.pattern: ${e.message}`; }
        if (f.as !== undefined && f.as !== 'date') return `extract.fields.${n}.as is date`;
    }
    if (!Array.isArray(x.require) || !x.require.length || !x.require.every((r) => names.includes(r))) return 'extract.require lists one or more of its fields';
    return null;
}

/** "October 20" / "Oct 20, 2026" → YYYY-MM-DD, the first such day on or after `published` (ISO), or null. */
function statedDate(text, published) {
    const m = /^([A-Za-z]{3,9})\.? (\d{1,2})(?:, (\d{4}))?$/.exec(String(text).trim());
    if (!m) return null;
    const month = MONTHS.findIndex((x) => x.startsWith(m[1].toLowerCase().slice(0, 3)) && (m[1].length === 3 || x === m[1].toLowerCase()));
    const day = Number(m[2]);
    if (month < 0 || day < 1 || day > 31) return null;
    const base = published ? new Date(published) : new Date();
    let year = m[3] ? Number(m[3]) : base.getUTCFullYear();
    const at = (y) => new Date(Date.UTC(y, month, day));
    if (!m[3] && at(year).getTime() < Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate())) year += 1;
    const d = at(year);
    if (d.getUTCMonth() !== month) return null;   // February 30
    return d.toISOString().slice(0, 10);
}

/** The items that yield every required field, as `kind` with those fields. → { items, skipped } */
function apply(items, x) {
    const rules = Object.entries(x.fields).map(([name, f]) => ({ name, from: f.from, re: new RegExp(f.pattern, 'i'), as: f.as }));
    const out = [];
    let skipped = 0;
    for (const it of items) {
        const fields = {};
        for (const r of rules) {
            const m = r.re.exec(String(it[r.from] || ''));
            if (!m || m[1] == null) continue;
            const v = m[1].trim().slice(0, 300);
            const value = r.as === 'date' ? statedDate(v, it.published_at) : v;
            if (value) fields[r.name] = value;
        }
        if (!x.require.every((n) => fields[n])) { skipped++; continue; }
        out.push({ ...it, kind: x.kind, fields: { ...(it.fields || {}), ...fields } });
    }
    return { items: out, skipped };
}

module.exports = { check, apply, statedDate };
