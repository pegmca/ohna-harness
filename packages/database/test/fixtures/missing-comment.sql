CREATE TABLE sample_records (
  id uuid PRIMARY KEY,
  title text NOT NULL
);

COMMENT ON COLUMN sample_records.id IS '记录主键';
