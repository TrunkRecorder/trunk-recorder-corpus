CREATE TABLE installs (
  token TEXT PRIMARY KEY,
  ip TEXT NOT NULL,
  created_ms INTEGER NOT NULL
);
CREATE INDEX idx_installs_ip ON installs (ip, created_ms);

CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  receipt TEXT NOT NULL,
  token TEXT NOT NULL,
  -- uploading → received → ready | failed
  state TEXT NOT NULL,
  purpose TEXT NOT NULL,
  tier TEXT NOT NULL,
  protocol TEXT NOT NULL,
  note TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  ready_ms INTEGER,
  results_token TEXT NOT NULL,
  checks TEXT
);
CREATE INDEX idx_submissions_state ON submissions (state, created_ms);
CREATE INDEX idx_submissions_token ON submissions (token, created_ms);

CREATE TABLE files (
  submission TEXT NOT NULL,
  name TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  -- None: the bucket has it already.
  upload_id TEXT,
  -- [{ partNumber, etag }]
  parts TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (submission, name)
);
CREATE INDEX idx_files_sha ON files (sha256);
