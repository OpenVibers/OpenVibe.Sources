#!/usr/bin/env node
'use strict';
/**
 * Load seeds/sources.json into the registry: creates sources that do not exist yet, DISABLED.
 * Never overwrites or enables an existing source. Enable one deliberately after verifying its terms:
 * PATCH /api/v1/sources/:key { "enabled": true } (sources.source.manage).
 *
 *   node scripts/seed.js [--db ./data/sources.db]
 */
require('dotenv').config();
const path = require('path');
const { load } = require('../server/config');
const { openDb } = require('../server/db');
const { createRegistry } = require('../server/registry');

function seed(db, { now = () => Date.now(), by = 'seed' } = {}) {
    const seeds = require(path.join(__dirname, '..', 'seeds', 'sources.json')).sources;
    const registry = createRegistry({ db, now });
    const out = { created: [], kept: [] };
    for (const s of seeds) {
        if (registry.get(s.key)) { out.kept.push(s.key); continue; }
        registry.create({ ...s, enabled: false }, by);
        out.created.push(s.key);
    }
    return out;
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const i = args.indexOf('--db');
    const config = load();
    const db = openDb(i >= 0 ? args[i + 1] : config.dbPath);
    const r = seed(db);
    console.log(`seeded ${r.created.length} source(s)${r.created.length ? `: ${r.created.join(', ')}` : ''}; kept ${r.kept.length} existing. All seeds are disabled.`);
    db.close();
}

module.exports = { seed };
