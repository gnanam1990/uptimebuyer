-- M00 bootstrap: extensions and a schema-version marker. Domain tables arrive with their owning modules via M02.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS platform_info (key text PRIMARY KEY, value text NOT NULL);
INSERT INTO platform_info(key, value) VALUES ('schema_family', 'uptimebuyer') ON CONFLICT (key) DO NOTHING;
