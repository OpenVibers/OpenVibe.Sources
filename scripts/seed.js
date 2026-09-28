#!/usr/bin/env node
'use strict';
/**
 * Load seeds/sources.json into the registry: creates sources that do not exist yet, DISABLED.
 * Never overwrites or enables an existing source. Enable one deliberately after verifying its terms:
 * PATCH /api/v1/sources/:key { "enabled": true } (sources.source.manage).
 *
 *   node scripts/seed.js            (DATABASE_URL from .env or /etc/openvibe/sources.env; without it, the development PGlite)
 */
require('dotenv').config();
const path = require('path');
const { load } = require('../server/config');
const { openDb } = require('../server/db');
const { createRegistry } = require('../server/registry');

async function seed(db, { now = () => Date.now(), by = 'seed' } = {}) {
    const seeds = require(path.join(__dirname, '..', 'seeds', 'sources.json')).sources;
    const registry = createRegistry({ db, now });
    const out = { created: [], kept: [] };
    for (const s of seeds) {
        if (await registry.get(s.key)) { out.kept.push(s.key); continue; }
        await registry.create({ ...s, enabled: false }, by);
        out.created.push(s.key);
    }
    return out;
}

if (require.main === module) {
    (async () => {
        const db = await openDb(load());   // DATABASE_URL (PostgreSQL); without it, the development PGlite
        const r = await seed(db);
        console.log(`seeded ${r.created.length} source(s)${r.created.length ? `: ${r.created.join(', ')}` : ''}; kept ${r.kept.length} existing. All seeds are disabled.`);
        await db.close();
    })().catch((err) => { console.error(`[seed] ${err.message}`); process.exit(1); });
}

module.exports = { seed };
