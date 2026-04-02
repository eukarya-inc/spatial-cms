ALTER TABLE dataset_definition ADD COLUMN IF NOT EXISTS publish_to_delivery BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE dataset_definition ADD COLUMN IF NOT EXISTS publish_to_ogc BOOLEAN NOT NULL DEFAULT false;
