-- Which recordings are regression tests: this table is the list.
CREATE TABLE regression (
  id TEXT PRIMARY KEY,
  submission TEXT NOT NULL UNIQUE,
  -- active | known-failing
  state TEXT NOT NULL,
  issue INTEGER,
  tolerance INTEGER NOT NULL DEFAULT 0,
  promoted_by TEXT NOT NULL,
  promoted_ms INTEGER NOT NULL
);

-- Looked at and left out of the tests.
ALTER TABLE submissions ADD COLUMN reviewed_by TEXT;
ALTER TABLE submissions ADD COLUMN reviewed_ms INTEGER;

-- Who's signed in with GitHub. The token has no scopes: it only asks GitHub who they are and what they may do.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  token TEXT NOT NULL,
  created_ms INTEGER NOT NULL
);

-- The reference captures, which were listed in Trunk Recorder Pro's corpus/corpus.json.
INSERT INTO regression (id, submission, state, promoted_by, promoted_ms)
SELECT v.column1, v.column2, 'active', 'robotastic', 1794182400000
FROM (VALUES
  ('p25', '0ba788a53b6c1551'), ('capplus', '118cbe9bf97a2d00'), ('capmax', '39c0fcf6945f5056'), ('smartnet', '0d5edbc931a28920'),
  ('conv-dmr', 'b147bce0dfae54ad'), ('conv-p25-fm', 'f164a2e8ddc33bd0'), ('phase2', '8ac89f0aeb6c6f95'), ('voice-p25', 'f6a56e409ce4a261'),
  ('voice-p25-phase2', 'c7be48ba3b702fc2'), ('voice-dmr', '9c3bdbd74bd11882'), ('voice-analog', 'b96f891837dfb816'), ('control-p25', '540ece8da8f682c5'),
  ('control-smartnet', '45c187df428b3d45')
) AS v
JOIN submissions s ON s.id = v.column2;
