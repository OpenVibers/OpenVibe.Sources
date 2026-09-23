# Proposal for OpenVibe.Contracts: `sources.source@1`, `sources.item@1`

Wave 14 asks OpenVibe.Contracts for the source-adapter contract. Files to add in its next release:

| File here | Goes to |
|---|---|
| [contracts/sources/source.v1.json](contracts/sources/source.v1.json) | `contracts/sources/source.v1.json` |
| [contracts/sources/item.v1.json](contracts/sources/item.v1.json) | `contracts/sources/item.v1.json` |
| [catalog-entries.json](catalog-entries.json) | two new entries in `contracts/catalog.json` |
| [../capabilities-proposal/*.json](../capabilities-proposal/) | `manifests/capabilities/` |
| [../service-manifest-proposal.json](../service-manifest-proposal.json) | `manifests/services/sources.json` |

`test/proposals.test.js` checks that the API's source and item views validate against these
schemas, that the capability and service manifests validate against the contracts' own
schemas, and that the seeds are valid.

## Events

| Type | Subject | Payload |
|---|---|---|
| `sources.item.created` | `{type: item, id, revision}` | item_id, source_key, category, kind, canonical_url, title, revision, content_hash, retrieved_at |
| `sources.item.updated` | same | + previous_content_hash |
| `sources.item.removed` | same | + reason |
| `sources.fetch.failed` | `{type: source, id: <key>}` | source_key, category, run_id, endpoint_url, state, error_code, http_status, consecutive_failures |
| `sources.index_document.upserted` | `{type: item, id, revision}` | a `search.index-document@1` (staff-only, noindex) |
| `sources.index_document.deleted` | same | `{type, id, revision}` |

OpenVibe.Events' default source prefixes do not include `sources` yet (`EVENTS_SOURCE_PREFIXES`
or a default-list change is needed before these publish).

## How products are expected to use items

A product never shows an item as its own fact: it keeps a typed reference
(`{service: 'sources', type: 'item', id, revision}`) as provenance, shows `retrieved_at` as the
observation time (a price is "as of", never "current"), treats `null` as unknown, honours
`terms_note`/`license_note`, starts its indexability decision from the source's
`default_indexability`/`review_required`/`sensitivity`, and reacts to `sources.item.updated` /
`removed` with a revision or a correction of its own.
