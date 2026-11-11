'use strict';
/**
 * The public page at sources.openvibe.network/ (browsers only; other clients get the text route index). Sources is an
 * internal service, so the page says what it does and where its two public doors are (the merchant opt-in and the
 * health endpoints), in the network's kit and theme like the merchant pages, never as a bare unstyled document.
 */
const kit = require('openvibe-shared/kit');
const { layout } = require('./merchant');

const fact = (title, sub) => kit.row({ title, sub });
const door = (title, href, sub) => kit.row({ title, href, sub });
// The kit's rows keep their second line to one line; these are sentences, so they wrap here. The button sits on the
// section's text inset.
const wrap = (html) => `<div class="src-wrap">${html}</div>`;
const STYLE = '<style>.src-wrap .ovk-row-sub>span{white-space:normal;overflow:visible;text-overflow:clip}.src-cta{margin:12px 15px 15px}</style>';

function homePage() {
    const body = `${STYLE}
${kit.head({ title: 'OpenVibe.Sources', sub: 'Where the network’s outside facts come from.' })}
${kit.section({
        title: 'What it does',
        note: 'An internal service of the OpenVibe network: there is nothing to browse here.',
        body: wrap(kit.list([
            fact('Keeps the list of sources', 'The feeds, sitemaps and APIs the network’s publication products may read, each with the terms it is read under.'),
            fact('Fetches politely', 'robots.txt is checked on every request, at the pace each source allows.'),
            fact('Records where every item came from', 'When it was fetched and under which terms. A failed fetch is recorded as a failure, never replaced with invented content.'),
            fact('Leaves publishing to the products', 'What reaches readers is published by the products themselves, under their own rules.'),
        ])),
    })}
${kit.section({
        title: 'List your store',
        body: `<p class="ovk-note">Merchants who want their store listed claim the domain, prove control of it, and name the sitemap or product feed we may read. Free, with honest ranking and no pay-to-win.</p>
<p class="src-cta">${kit.button({ href: '/merchant', label: 'List your store on OpenVibe' })}</p>`,
    })}
${kit.section({
        title: 'For developers',
        body: wrap(kit.list([
            door('Health', '/api/health', 'Is the service up'),
            door('Readiness', '/api/ready', 'The database, the Network key and the fetcher'),
            door('Release', '/release.json', 'The deployed release'),
            door('Source code', 'https://github.com/OpenVibers/OpenVibe.Sources', 'OpenVibers/OpenVibe.Sources on GitHub (AGPL-3.0)'),
        ])),
    })}`;
    return layout({ title: 'OpenVibe.Sources', description: 'The registry of outside sources the OpenVibe network reads, and where merchants list their store.', body, arrival: true })
        // The layout titles its pages "… · OpenVibe.Sources"; the home is the site itself.
        .replace('<title>OpenVibe.Sources · OpenVibe.Sources</title>', '<title>OpenVibe.Sources</title>');
}

module.exports = { homePage };
