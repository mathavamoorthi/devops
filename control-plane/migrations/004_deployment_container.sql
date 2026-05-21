ALTER TABLE deployments ADD COLUMN IF NOT EXISTS image_tag      TEXT;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS container_name TEXT;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS app_type       TEXT;
