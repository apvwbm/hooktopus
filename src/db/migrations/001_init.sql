CREATE TABLE bins (
  id         TEXT PRIMARY KEY,   -- 16 base64url chars, 96 bits: the id IS the credential
  created_at INTEGER NOT NULL,   -- epoch ms
  expires_at INTEGER NOT NULL
);
CREATE INDEX bins_expires ON bins (expires_at);

CREATE TABLE requests (
  -- AUTOINCREMENT, not just INTEGER PRIMARY KEY: ids are never reused, even
  -- after the newest rows are deleted. The live stream resumes from an id, and
  -- a reused one would make a client skip a request it never saw.
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  bin_id       TEXT NOT NULL REFERENCES bins (id) ON DELETE CASCADE,
  received_at  INTEGER NOT NULL,
  method       TEXT NOT NULL,
  url          TEXT NOT NULL,    -- path and query exactly as received, minus /h/<bin>
  headers      TEXT NOT NULL,    -- JSON [[name, value], ...] from rawHeaders: order, case, duplicates
  content_type TEXT,             -- denormalised for the list, which never parses headers
  body         BLOB,             -- the exact bytes; NULL when there was none
  body_size    INTEGER NOT NULL,
  ip           TEXT NOT NULL
);
CREATE INDEX requests_bin ON requests (bin_id, id);
