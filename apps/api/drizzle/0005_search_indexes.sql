CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX products_fts_idx ON products USING gin (
  to_tsvector('portuguese', name || ' ' || coalesce(description, ''))
);
--> statement-breakpoint
CREATE INDEX products_name_trgm_idx ON products USING gin (name gin_trgm_ops);
