'use strict';
/**
 * Steam's featured lists for OpenVibe.Games (category games, contracts 0.205.0; the owner's valve.openvibe.games ask):
 * store.steampowered.com/api/featuredcategories, which robots.txt allows (api.steampowered.com, which disallows
 * everything, is never fetched), read every 3 hours. One source per list (top sellers, new releases, specials), so a
 * game on two lists is two items rather than one identity overwritten by the other list. Each item keeps the app id,
 * the name, the prices in cents, the discount, the currency, the header image and the platforms.
 */
const assert = require('assert');
const api = require('../server/adapters/api');
const { validateSource, CATEGORIES } = require('../server/registry');
const { load } = require('../server/config');
const { suite } = require('./helpers');

const t = suite('steam-sources');
const seeds = require('../seeds/sources.json').sources;
const lists = ['steam-top-sellers', 'steam-new-releases', 'steam-specials'].map((k) => seeds.find((s) => s.key === k));

const game = (id, name, extra = {}) => ({
    id, type: 0, name, discounted: false, discount_percent: 0, original_price: 2999, final_price: 2999, currency: 'USD',
    large_capsule_image: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${id}/capsule_616x353.jpg`,
    header_image: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${id}/header.jpg`,
    windows_available: true, mac_available: false, linux_available: true, controller_support: 'full', ...extra,
});
const BODY = JSON.stringify({
    top_sellers: { id: 'cat_topsellers', name: 'Top Sellers', items: [game(730, 'Counter-Strike 2', { final_price: 0, original_price: 0 }), game(4435490, 'Call of Duty®: Modern Warfare® 4', { final_price: 6999, original_price: 6999 })] },
    new_releases: { id: 'cat_newreleases', name: 'New Releases', items: [game(3527290, 'A New Game')] },
    specials: { id: 'cat_specials', name: 'Specials', items: [game(413150, 'Stardew Valley', { discounted: true, discount_percent: 50, final_price: 749, original_price: 1499, discount_expiration: 1792800000 })] },
    coming_soon: { id: 'cat_comingsoon', name: 'Coming Soon', items: [game(1, 'Not read')] },
    status: 1,
});

t('the seeds validate, start disabled, are games sources on the robots-allowed store API, every 3 hours', () => {
    assert.ok(CATEGORIES.includes('games'));
    for (const s of lists) {
        assert.ok(s, 'seeded');
        const rec = validateSource(s);
        assert.strictEqual(rec.enabled, false);
        assert.strictEqual(rec.category, 'games');
        assert.ok(rec.robots_note && rec.terms_note && rec.license_note, `${s.key}: robots, terms and licence notes`);
        assert.strictEqual(new URL(s.endpoints[0].url).host, 'store.steampowered.com', 'never api.steampowered.com');
        assert.strictEqual(s.poll_interval_sec, 10800);
        assert.ok(rec.max_items <= load({}).items.maxPerFetch);
    }
});

t('each list is its own items: id, name, prices, discount, image and platforms', () => {
    const [top, fresh, specials] = lists.map((s) => api.parse(BODY, { url: s.endpoints[0].url, endpoint: s.endpoints[0], maxItems: s.max_items }).items);
    assert.deepStrictEqual(top.map((i) => [i.kind, i.identity, i.title]), [['steam_top_seller', '730', 'Counter-Strike 2'], ['steam_top_seller', '4435490', 'Call of Duty®: Modern Warfare® 4']]);
    assert.deepStrictEqual(fresh.map((i) => i.identity), ['3527290']);
    const [sale] = specials;
    assert.strictEqual(sale.kind, 'steam_special');
    assert.deepStrictEqual(
        [sale.fields.appid, sale.fields.final_price, sale.fields.original_price, sale.fields.discount_percent, sale.fields.currency, sale.fields.windows, sale.fields.linux, sale.fields.mac, sale.fields.discount_expiration],
        [413150, 749, 1499, 50, 'USD', true, true, false, 1792800000],
    );
    assert.match(sale.fields.header_image, /^https:\/\/shared\.akamai\.steamstatic\.com\/.+header\.jpg$/);
    assert.ok(![...top, ...fresh, ...specials].some((i) => i.title === 'Not read'), 'coming soon is not one of the lists');
    assert.deepStrictEqual(top.map((i) => i.fields.position), [0, 1], "a list keeps the store's order ($index)");
});

t('$index is an array record\'s position, as a whole path, never on a map', () => {
    const ep = (extra, shape) => ({ url: 'https://example.org/x', items_path: 'list', ...(shape ? { items_shape: shape } : {}), fields: { identity: 'id' }, extra });
    assert.strictEqual(api.checkMapping(ep({ position: '$index' })), null);
    assert.match(api.checkMapping(ep({ position: '$index' }, 'map')), /\$index requires items_shape "array"/);
    assert.match(api.checkMapping(ep({ position: 'a.$index' })), /exactly "\$index"/);
});
