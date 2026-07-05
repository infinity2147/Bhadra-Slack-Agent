CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,              -- INC-YYYYMMDD-XXX
  title TEXT NOT NULL,
  status TEXT NOT NULL,             -- detected|triage|active|monitoring|resolved|postmortem_done
  severity TEXT,                    -- SEV1..SEV4
  service TEXT,
  channel_id TEXT,
  triage_thread_ts TEXT,
  commander_user_id TEXT,
  comms_user_id TEXT,
  scribe_user_id TEXT,
  started_at INTEGER NOT NULL,
  detected_at INTEGER,
  resolved_at INTEGER,
  cost_estimate_usd REAL DEFAULT 0,
  is_drill INTEGER DEFAULT 0,
  summary TEXT,                     -- filled at resolution
  root_cause TEXT,
  resolution TEXT,
  postmortem_doc TEXT               -- final markdown
);

CREATE TABLE IF NOT EXISTS timeline_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,               -- signal|status_change|action|message|mcp_data|update_sent
  actor TEXT,                       -- user id or 'sentinel'
  content TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT, message_ts TEXT, user_id TEXT,
  text TEXT, score REAL, category TEXT,   -- latency|errors|outage|confusion|deploy_suspicion
  created_at INTEGER,
  incident_id TEXT                        -- null until clustered into an incident
);

CREATE TABLE IF NOT EXISTS embeddings (
  incident_id TEXT PRIMARY KEY REFERENCES incidents(id),
  vector BLOB NOT NULL                    -- Float32Array of summary embedding
);

CREATE TABLE IF NOT EXISTS interviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id TEXT REFERENCES incidents(id),
  user_id TEXT, question TEXT, answer TEXT, asked_at INTEGER, answered_at INTEGER
);

CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);
