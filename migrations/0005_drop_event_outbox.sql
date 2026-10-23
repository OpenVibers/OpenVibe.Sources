-- phase: contract
-- after: 0002
-- The SDK outbox (service_outbox, migration 0002, 2026-10-10) has carried every Sources event since; no code reads
-- event_outbox, and its 2,400 rows were all sent or rejected when this was written (2026-10-23).
DROP TABLE IF EXISTS event_outbox;
