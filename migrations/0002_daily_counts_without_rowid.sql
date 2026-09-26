-- ADR-0014: daily_counts keeps no rowid. A rowid is handed out in insertion order, so it
-- would record which link was first counted before another, which is more than "which
-- link, the UTC day, and that day's count" (ADR-0004). WITHOUT ROWID stores each row by
-- its key (link_id, day) alone. The rows are copied in key order; the old table's pages are
-- zeroed by secure_delete (ADR-0012), and gone from the file once the service rebuilds it at start.
CREATE TABLE daily_counts_by_key (
  link_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (link_id, day)
) WITHOUT ROWID;

INSERT INTO daily_counts_by_key (link_id, day, count)
  SELECT link_id, day, count FROM daily_counts ORDER BY link_id, day;

DROP TABLE daily_counts;

ALTER TABLE daily_counts_by_key RENAME TO daily_counts;
