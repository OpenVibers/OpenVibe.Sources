'use strict';
/**
 * The merchant opt-in pages: plain semantic markup built with the OpenVibe Kit (openvibe-shared/kit), so the page keeps
 * the network's classes and the main session styles the pieces it adds. No client-side state: every action is a form.
 */
const kit = require('openvibe-shared/kit');

const esc = kit.esc;

const STATUS = {
    pending: ['pending', 'warn'],
    verified: ['verified', 'ok'],
    withdrawn: ['withdrawn', ''],
    failed: ['failed', 'bad'],
};

const statusBadge = (status) => {
    const [label, tone] = STATUS[status] || [status, ''];
    return kit.badge(label, tone);
};

const when = (iso) => {
    if (!iso) return '';
    const t = kit.when(iso);
    return t.text ? `<time datetime="${esc(t.iso)}">${esc(t.text)}</time>` : '';
};

const csrfInput = (csrf) => `<input type="hidden" name="csrf" value="${esc(csrf)}">`;

function layout({ title = 'List your store on OpenVibe', body = '', description = '' }) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="dark light">
<title>${esc(title)} · OpenVibe.Sources</title>
${description ? `<meta name="description" content="${esc(description)}">` : ''}
<script src="/shared/theme-loader.js"></script>
<link rel="stylesheet" href="/shared/kit.css">
<style>html{background:var(--ovk-bg);color:var(--ovk-text)}body{margin:0}</style>
</head>
<body>
<main class="ovk-page">
${body}
</main>
<script src="/shared/kit-web.js" defer></script>
</body>
</html>`;
}

function notice(kind, text) {
    return text ? kit.notice({ kind, text }) : '';
}

function guestPage({ error = '', authError = '' } = {}) {
    const body = `${kit.head({ title: 'List your store on OpenVibe', sub: 'Free, with honest ranking and no pay-to-win.' })}
${notice('error', error)}
${authError ? kit.notice({ kind: 'warn', text: `Sign-in did not complete (${authError}). Please try again.` }) : ''}
${kit.section({
        title: 'How it works',
        body: `<ol class="ovk-list">
<li class="ovk-row ovk-row--static"><span class="ovk-row-main"><span class="ovk-row-top"><strong>1. Claim your domain</strong></span><span class="ovk-row-sub"><span>Sign in, add the domain your shop uses, and name the sitemap or product feed we may read.</span></span></span></li>
<li class="ovk-row ovk-row--static"><span class="ovk-row-main"><span class="ovk-row-top"><strong>2. Prove you control it</strong></span><span class="ovk-row-sub"><span>Publish a DNS TXT record or a meta tag. Nothing is crawled or enabled until the proof is found.</span></span></span></li>
<li class="ovk-row ovk-row--static"><span class="ovk-row-main"><span class="ovk-row-top"><strong>3. We crawl politely</strong></span><span class="ovk-row-sub"><span>robots.txt is checked on every request. We read what your pages publish for machines, with provenance.</span></span></span></li>
<li class="ovk-row ovk-row--static"><span class="ovk-row-main"><span class="ovk-row-top"><strong>4. You stay in control</strong></span><span class="ovk-row-sub"><span>Withdraw at any time: the source is disabled and the permission note is kept for the audit trail.</span></span></span></li>
</ol>`,
    })}
${kit.section({
        title: 'Sign in to start',
        body: `<p class="ovk-note">A merchant signs in with an OpenVibe.Network account. The claim belongs to that account.</p>
<p>${kit.button({ href: '/merchant/login?next=%2Fmerchant', label: 'Sign in with OpenVibe', icon: 'user' })}</p>`,
    })}`;
    return layout({ body });
}

function claimRow(claim) {
    const source = claim.source;
    const sub = `${claim.listing.kind === 'sitemap' ? 'Sitemap' : 'Product feed'} · ${claim.listing.url}`;
    const trail = source ? statusBadge(source.health.status) : '';
    return kit.row({
        href: `/merchant/sources/${claim.id}`,
        title: claim.domain,
        badge: statusBadge(claim.status),
        sub,
        meta: claim.created_at ? kit.when(claim.created_at).text : '',
        metaIso: claim.created_at || '',
        trail,
    });
}

function merchantPage({ merchant, claims = [], csrf, notice: noticeText = '', error = '', authError = '' }) {
    const list = claims.length
        ? kit.list(claims.map(claimRow), { title: 'Your merchant sources' })
        : kit.empty({ title: 'No store listed yet', text: 'Add your first domain below. It becomes a source only after you prove you control it and the proof is found.', icon: 'globe' });

    const form = `<form class="ovk-form" method="post" action="/merchant/sources">
${csrfInput(csrf)}
<label>Store domain <input name="domain" required maxlength="253" autocomplete="off" placeholder="shop.example.com" spellcheck="false"></label>
<label>Store name (optional) <input name="store_name" maxlength="120" autocomplete="organization" placeholder="Example Shop"></label>
${kit.seg({ name: 'method', label: 'How will you prove control?', value: 'dns', options: [['dns', 'DNS TXT record'], ['meta', 'Meta tag']] })}
${kit.selectRow({ name: 'listing_kind', label: 'What should we read?', hint: 'A sitemap of product pages, or an RSS/Atom product feed.', options: [['sitemap', 'Sitemap'], ['feed', 'Product feed (RSS/Atom)']], value: 'sitemap' })}
<label>Sitemap or product feed URL <input name="listing_url" type="url" required maxlength="2048" autocomplete="url" placeholder="https://shop.example.com/sitemap.xml" spellcheck="false"></label>
<label>Meta tag page (only for method meta; defaults to your home page) <input name="meta_url" type="url" maxlength="2048" autocomplete="url" placeholder="https://shop.example.com/" spellcheck="false"></label>
<p class="ovk-note">Nothing is created or enabled before the proof is found. robots.txt is still obeyed after that.</p>
${kit.button({ label: 'Add domain', icon: 'plus' })}
</form>`;

    const body = `${kit.head({
        title: 'List your store on OpenVibe',
        sub: `Signed in as ${merchant.name || merchant.subject}.`,
        actions: [kit.button({ href: '/merchant/logout', label: 'Sign out', kind: 'quiet', icon: 'leave', small: true })],
    })}
${notice('ok', noticeText)}
${notice('error', error)}
${authError ? kit.notice({ kind: 'warn', text: `Sign-in did not complete (${authError}). Please try again.` }) : ''}
${kit.section({ title: 'Add a store', body: form })}
${list}
<p class="ovk-note">A full merchant dashboard with charts and history lives in OpenVibe.Report later. This page is the opt-in flow; the same sources are readable as JSON at <code>/api/v1/merchant/sources</code> with your session or a first-party service token.</p>`;
    return layout({ body });
}

function sourcePanel(claim) {
    const source = claim.source;
    const terms = claim.terms_note
        ? `<h3>Terms note</h3><p class="ovk-note">${esc(claim.terms_note)}</p>`
        : '';
    if (!source) return `${terms}<p class="ovk-note">No source exists yet. Verification creates it; nothing is fetched before that.</p>`;
    const health = source.health;
    const last = claim.last_run;
    const crawl = claim.last_crawl;
    const runs = claim.recent_runs && claim.recent_runs.length
        ? `<h3>Last fetches</h3><ul class="ovk-list">${claim.recent_runs.map(r => `<li class="ovk-row ovk-row--static"><span class="ovk-row-main"><span class="ovk-row-top"><strong>${esc(r.state)}</strong><span class="ovk-row-meta">${esc(r.started_at ? kit.when(r.started_at).text : '')}</span></span><span class="ovk-row-sub"><span>${esc(r.endpoint_url || '')} · ${Number(r.items.seen)} seen, ${Number(r.items.created)} created</span></span></span></li>`).join('')}</ul>`
        : '<p class="ovk-note">No fetch has run yet.</p>';
    const crawler = crawl
        ? `<p>${Number(crawl.pages)} page(s) known, ${Number(crawl.due)} due${crawl.next_due_at ? ` · next ${when(crawl.next_due_at)}` : ''}.</p>
${Object.keys(crawl.pages_by_state || {}).length ? `<p class="ovk-note">Pages: ${Object.entries(crawl.pages_by_state).map(([k, v]) => `${esc(k)} ${Number(v)}`).join(' · ')}</p>` : ''}
${crawl.recent && crawl.recent.length ? `<ul class="ovk-list">${crawl.recent.map(p => `<li class="ovk-row ovk-row--static"><span class="ovk-row-main"><span class="ovk-row-top"><strong>${esc(p.url)}</strong><span class="ovk-row-meta">${esc(p.state)}</span></span><span class="ovk-row-sub"><span>${Number(p.items)} item(s) · ${p.http_status == null ? 'not fetched' : `HTTP ${Number(p.http_status)}`}</span></span></span></li>`).join('')}</ul>` : ''}`
        : '';
    return `${claim.store_name ? `<p class="ovk-note">${esc(claim.store_name)}</p>` : ''}${terms}
<dl class="ovk-stats">
<div><dt>source</dt><dd><code>${esc(source.key)}</code></dd></div>
<div><dt>type</dt><dd>${esc(source.type)}</dd></div>
<div><dt>enabled</dt><dd>${source.enabled ? 'yes' : 'no'}</dd></div>
<div><dt>health</dt><dd>${esc(health.status)}</dd></div>
</dl>
${health.last_success_at ? `<p class="ovk-note">Last success ${when(health.last_success_at)}${health.last_state ? ` · last state ${esc(health.last_state)}` : ''}.</p>` : ''}
${last ? `<p class="ovk-note">Last run ${esc(last.state)} at ${when(last.started_at)}${last.detail ? `: ${esc(last.detail)}` : ''}.</p>` : ''}
${crawler}
${runs}`;
}

function detailPage({ merchant, claim, csrf, notice: noticeText = '', noticeKind = 'ok', error = '' }) {
    const challenge = claim.verification.challenge;
    const pending = claim.status === 'pending';
    const verified = claim.status === 'verified';
    const withdrawn = claim.status === 'withdrawn';
    const failed = claim.status === 'failed';

    let proof = '';
    if (pending) {
        const how = claim.method === 'dns'
            ? `<p>Publish this DNS record at your DNS provider:</p>
${kit.snippet({ code: `${challenge.name}  IN  TXT  "${challenge.value}"` })}
<dl class="ovk-stats">
<div><dt>type</dt><dd>TXT</dd></div>
<div><dt>name</dt><dd><code>${esc(challenge.name)}</code></dd></div>
<div><dt>value</dt><dd><code>${esc(challenge.value)}</code></dd></div>
</dl>`
            : `<p>Put this tag in the <code>&lt;head&gt;</code> of <a href="${esc(challenge.url)}" rel="noopener">${esc(challenge.url)}</a>:</p>
${kit.snippet({ code: challenge.html })}
<p class="ovk-note">The page must stay on ${esc(claim.domain)} (a redirect to another host is refused).</p>`;
        proof = `${how}
<div>${kit.action({ action: `/merchant/sources/${claim.id}/verify`, hidden: { csrf }, label: 'Check now', icon: 'retry' })}</div>
${claim.verification.last_error ? kit.notice({ kind: 'warn', text: claim.verification.last_error }) : ''}`;
        if (claim.verification.last_checked_at) proof += `<p class="ovk-note">Checked ${Number(claim.verification.check_count || 0)} time(s); last ${when(claim.verification.last_checked_at)}.</p>`;
    } else if (verified) {
        proof = kit.notice({ kind: 'ok', text: `Verified ${claim.verification.detail || (claim.method === 'dns' ? 'by DNS TXT record' : 'by meta tag')} at ${claim.verification.verified_at}. The source is enabled.` });
        proof += `<p class="ovk-note">You can keep the ${claim.method === 'dns' ? 'TXT record' : 'meta tag'} in place, but it is no longer needed to keep the source enabled. Withdrawing is the explicit way to stop it.</p>`;
    } else if (withdrawn) {
        proof = kit.notice({ kind: 'info', text: `Permission withdrawn at ${claim.withdrawal && claim.withdrawal.at ? claim.withdrawal.at : claim.updated_at}. The source is disabled and its terms note is kept.` });
    } else if (failed) {
        proof = kit.notice({ kind: 'error', text: `This claim failed before verification: ${claim.verification.last_error || 'the proof was not found in time'}. Add the domain again to opt in.` });
    }

    const actions = [];
    if (!withdrawn) {
        actions.push(kit.action({
            action: `/merchant/sources/${claim.id}/withdraw`,
            hidden: { csrf },
            label: 'Withdraw permission',
            icon: 'ban',
            kind: 'danger',
            confirm: 'Withdraw this permission? The source is disabled and the permission note is kept.',
        }));
    }

    const body = `${kit.head({
        title: claim.domain,
        sub: `${claim.listing.kind === 'sitemap' ? 'Sitemap' : 'Product feed'} · ${claim.listing.url}`,
        back: { href: '/merchant', label: 'Merchant opt-in' },
        actions: [statusBadge(claim.status)],
    })}
${notice(noticeKind, noticeText)}
${notice('error', error)}
${kit.section({ title: pending ? 'Prove you control this domain' : 'Verification', body: proof })}
${kit.section({ title: 'Source and last crawl', body: sourcePanel(claim) })}
${actions.length ? kit.section({ title: 'Withdraw', body: actions.join('') }) : ''}`;
    return layout({ title: `${claim.domain} · Merchant opt-in`, body });
}

function errorPage({ status = 400, message = 'Something went wrong.' } = {}) {
    const body = `${kit.head({ title: 'Merchant opt-in' })}
${kit.notice({ kind: 'error', text: message })}
<p><a href="/merchant">Back to merchant opt-in</a></p>`;
    return { status, html: layout({ title: 'Merchant opt-in', body }) };
}

module.exports = { layout, guestPage, merchantPage, detailPage, errorPage, statusBadge, claimRow };
