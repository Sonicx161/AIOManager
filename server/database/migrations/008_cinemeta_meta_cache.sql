-- Migration 008: shared durable Cinemeta metadata cache; the functional creation path is ensureTable in server/database/setup.js.
-- Public catalog data keyed by IMDb id and media type, never per user. payload is the zlib-deflated slim meta JSON
-- (NULL for a negative 404 entry). Use BYTEA instead of BLOB on PostgreSQL.

CREATE TABLE IF NOT EXISTS cinemeta_meta_cache (
  imdb_id TEXT NOT NULL,
  media_type TEXT NOT NULL,
  status INTEGER NOT NULL,
  payload BLOB,
  fetched_at BIGINT NOT NULL,
  PRIMARY KEY (imdb_id, media_type)
);

CREATE INDEX IF NOT EXISTS idx_cinemeta_meta_cache_fetched ON cinemeta_meta_cache (fetched_at);
