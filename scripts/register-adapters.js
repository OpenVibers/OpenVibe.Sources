#!/usr/bin/env node
'use strict';
/**
 * Register adapters/*.json (written by scripts/adapters-from-evidence.mjs from evidence/*.json, ADR 0007): creates each
 * source that does not exist and brings an existing one to its adapter, including `enabled`, which the probe's verdict
 * decided (ok → on, structured-only → off). A queued domain has no adapter, so nothing here touches it.
 *
 *   node scripts/register-adapters.js [--dry-run]   (DATABASE_URL as for scripts/seed.js)
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { load } = require('../server/config');
const { openDb } = require('../server/db');
const { createRegistry } = require('../server/registry');

const DIR = path.join(__dirname, '..', 'adapters');

async function register(db, { now = () => Date.now(), by = 'adr-0007', maxItemsCap, dryRun = false } = {}) {
    const registry = createRegistry({ db, now, ...(maxItemsCap ? { maxItemsCap } : {}) });
    const out = { created: [], updated: [], same: [] };
    for (const f of fs.readdirSync(DIR).filter(x => x.endsWith('.json')).sort()) {
        const a = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
        const row = await registry.get(a.key);
        if (!row) {
            if (!dryRun) await registry.create(a, by);
            out.created.push(a.key);
            continue;
        }
        const was = registry.fromRow(row);
        const changed = Object.keys(a).some(k => JSON.stringify(a[k]) !== JSON.stringify(was[k]));
        if (!changed) { out.same.push(a.key); continue; }
        if (!dryRun) await registry.patch(a.key, a, by);
        out.updated.push(a.key);
    }
    return out;
}

if (require.main === module) {
    (async () => {
        const config = load();
        const db = await openDb(config);
        const r = await register(db, { maxItemsCap: config.items.maxPerFetch, dryRun: process.argv.includes('--dry-run') });
        console.log(`created ${r.created.length}${r.created.length ? ` (${r.created.join(', ')})` : ''}; updated ${r.updated.length}`
            + `${r.updated.length ? ` (${r.updated.join(', ')})` : ''}; unchanged ${r.same.length}`);
        await db.close();
    })().catch((err) => { console.error(`[register-adapters] ${err.message}`); process.exit(1); });
}

module.exports = { register };
