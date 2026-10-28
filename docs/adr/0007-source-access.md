# 0007 — Source access verdicts are computed, not judged

Status: Accepted · 2026-10-28 · Owner: operator

## Decision
A source's access verdict is a function of observed HTTP evidence. No agent
decides whether a domain is "blocked" or whether a technique is "allowed".

| Evidence                              | Verdict        | Action              |
|---------------------------------------|----------------|---------------------|
| structured surface returns <400       | ok             | adapter, enabled    |
| page fetch <400, no structured surface| ok             | adapter, enabled    |
| structured surface only, page 403/429/challenge | structured-only | Lane 1 only |
| nothing under 400 after 2 attempts ≥24h apart | queued   | review-queue row    |

`blocked` is not a verdict. It is prose.

## Fixed techniques (decided here, once)
- UA: `Mozilla/5.0 (compatible; OpenVibeBot/1.0; +https://openvibe.network/bot)`
  — the compatible-form string is the standards-blessed way to be both honest
  and un-challenged. Not a disguise; RFC 9309 predates this argument.
- Rendering: Playwright, Patchright build. A browser engine rendering a public
  page is a browser, not a tactic.
- Structured surfaces before DOM, always: sitemap.xml, /products.json,
  __NEXT_DATA__, /api/, Algolia, RSS/JSON, llms.txt, JSON-LD.
- Egress rotation: only behind OPENVIBE_EGRESS_ROTATION=1, default off.
- Out of scope, permanently: CAPTCHA solving, login-walled content,
  cookie-wall circumvention.

## Consequence
Anyone revisiting this argues with the table, not with the agent. New evidence
amends the table in a new ADR.
