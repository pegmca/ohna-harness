CREATE TABLE sample_records (
  -- 主键列前的行注释不应让静态检查漏掉字段。
  id uuid PRIMARY KEY,
  /* 标题列前的块注释同样必须被跳过。 */
  title text NOT NULL
) ;

COMMENT ON COLUMN sample_records.id IS '记录主键';
