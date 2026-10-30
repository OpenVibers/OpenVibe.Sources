-- phase: expand
-- A source's small persistent cursor (server/adapters/off-delta.js): the off-delta bulk resolver keeps the last
-- completed delta part and, while a part is still being read, its row offset. One row per source and cursor name;
-- the value is JSON text owned by that resolver. Nothing here belongs to a person.

CREATE TABLE IF NOT EXISTS source_state (
    source_key  text COLLATE "C" NOT NULL,
    name        text COLLATE "C" NOT NULL,
    value       text NOT NULL,
    updated_at  bigint NOT NULL,
    PRIMARY KEY (source_key, name)
);
