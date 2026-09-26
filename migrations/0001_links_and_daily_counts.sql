-- ADR-0003, column for column. Nothing else belongs here: every column is something
-- the privacy page promises about (ADR-0004). daily_counts has no foreign key on
-- purpose, because counts outlive their link, and AUTOINCREMENT is what stops a
-- deleted link's id, and so its counts, from being handed to a new link.
CREATE TABLE links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  target TEXT NOT NULL,
  made_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NULL
);

CREATE TABLE daily_counts (
  link_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (link_id, day)
);
