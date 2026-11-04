-- Idempotent seed: no tenant or personal data; demo tenants are seeded by later modules and labelled as demo.
INSERT INTO platform_info(key, value) VALUES ('seeded', 'true') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
