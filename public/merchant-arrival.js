/* The Sources home and merchant guest page pick up an existing Network session. */
(async () => {
    'use strict';
    if (new URLSearchParams(location.search).get('sso') === 'none') return;
    if (/bot|crawl|spider|slurp|headless/i.test(navigator.userAgent || '')) return;
    try {
        const r = await fetch('/auth/me', { credentials: 'same-origin', cache: 'no-store' });
        if (r.ok && (await r.json()).user) return;
    } catch { /* A failed check cannot grant a session. */ }

    const hint = (document.cookie.match(/(?:^|;\s*)ov_sso_hint=([^;]*)/) || [])[1];
    if (hint === 'guest') return;
    try {
        if (Date.now() - Number(sessionStorage.getItem('ov_sources_silent_at') || 0) < 10 * 60 * 1000) return;
    } catch { return; }
    const signIn = () => {
        try { sessionStorage.setItem('ov_sources_silent_at', String(Date.now())); } catch { return; }
        const next = location.pathname === '/' ? '/' : '/merchant';
        location.replace(`/merchant/login?silent=1&next=${encodeURIComponent(next)}`);
    };
    let fromNetwork = false;
    try { fromNetwork = new URL(document.referrer).origin === 'https://openvibe.network'; } catch { /* no referrer */ }
    if (hint === 'account' || fromNetwork) return signIn();

    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('tabindex', '-1');
    frame.style.cssText = 'position:absolute;width:0;height:0;border:0;opacity:0;pointer-events:none';
    const finish = (signedIn) => {
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        frame.remove();
        if (signedIn) signIn();
    };
    const onMessage = (event) => {
        if (event.origin !== 'https://openvibe.network' || event.source !== frame.contentWindow || event.data?.type !== 'ov-sso') return;
        finish(event.data.signedIn === true);
    };
    window.addEventListener('message', onMessage);
    const timer = setTimeout(() => finish(false), 4000);
    frame.src = `https://openvibe.network/sso/check?origin=${encodeURIComponent(location.origin)}`;
    document.body.appendChild(frame);
})();
