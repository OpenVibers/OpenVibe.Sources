'use strict';
/**
 * The item count behind the metrics and readiness (server/observability.js kept): callers at the same moment share one
 * read; within keepMs the kept answer; past it, read again; a failed read is not kept; keepMs 0 reads every time.
 *
 *   node test/kept-counts.test.js
 */
const assert = require('assert');
const { kept } = require('../server/observability');

(async () => {
    let t = 0;
    let reads = 0;
    let fail = false;
    const read = async () => { reads += 1; if (fail) throw new Error('db away'); return { current: reads, removed: 0 }; };
    const k = kept(read, 30_000, () => t);
    const [a, b] = await Promise.all([k(), k()]);
    assert.strictEqual(reads, 1, 'two callers at once: one read');
    assert.deepStrictEqual(a, b);
    t = 29_000;
    assert.strictEqual((await k()).current, 1, 'within the window: kept');
    t = 30_000;
    assert.strictEqual((await k()).current, 2, 'past it: read again');
    fail = true;
    t = 61_000;
    await assert.rejects(k(), /db away/);
    fail = false;
    assert.strictEqual((await k()).current, 4, 'a failed read is not kept: the next call reads');
    let plain = 0;
    const every = kept(async () => ++plain, 0);
    await every(); await every();
    assert.strictEqual(plain, 2, 'keepMs 0: every call reads');
    console.log('kept counts: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
