-- Migration number: 0005 	 2026-11-11T17:00:00.000Z
-- THE-181: remember how site discovery found each page ("entry", "sitemap",
-- "internal_link", "canonical") so SEO checks can flag pages that the XML
-- sitemap lists but that block indexing. Additive: existing rows get '[]',
-- which SEO checks treat as "not known to be in the sitemap".

ALTER TABLE pages ADD COLUMN discovery_sources_json TEXT NOT NULL DEFAULT '[]';
