import BetterSqlite3 from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Database = BetterSqlite3.Database;

export type IncidentStatus =
  | 'detected'
  | 'triage'
  | 'active'
  | 'monitoring'
  | 'resolved'
  | 'postmortem_done';

export type Severity = 'SEV1' | 'SEV2' | 'SEV3' | 'SEV4';

export interface Incident {
  id: string;
  title: string;
  status: IncidentStatus;
  severity: Severity | null;
  service: string | null;
  channel_id: string | null;
  triage_thread_ts: string | null;
  commander_user_id: string | null;
  comms_user_id: string | null;
  scribe_user_id: string | null;
  started_at: number;
  detected_at: number | null;
  resolved_at: number | null;
  cost_estimate_usd: number;
  is_drill: number;
  summary: string | null;
  root_cause: string | null;
  resolution: string | null;
  postmortem_doc: string | null;
}

export type TimelineKind = 'signal' | 'status_change' | 'action' | 'message' | 'mcp_data' | 'update_sent';

export interface TimelineEvent {
  id: number;
  incident_id: string;
  ts: number;
  kind: TimelineKind;
  actor: string | null;
  content: string;
}

export type SignalCategory = 'latency' | 'errors' | 'outage' | 'confusion' | 'deploy_suspicion';

export interface Signal {
  id: number;
  channel_id: string | null;
  message_ts: string | null;
  user_id: string | null;
  text: string | null;
  score: number | null;
  category: SignalCategory | null;
  created_at: number | null;
  incident_id: string | null;
  service_guess?: string | null;
}

export interface Interview {
  id: number;
  incident_id: string | null;
  user_id: string | null;
  question: string | null;
  answer: string | null;
  asked_at: number | null;
  answered_at: number | null;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

export function openDb(path = ':memory:'): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new BetterSqlite3(path);
  db.pragma('journal_mode = WAL');
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(schema);
  // service_guess is needed for clustering; keep spec schema verbatim and extend additively.
  const cols = db.prepare(`PRAGMA table_info(signals)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'service_guess')) {
    db.exec(`ALTER TABLE signals ADD COLUMN service_guess TEXT`);
  }
  return db;
}

// ── incidents ────────────────────────────────────────────────────────────────

export function nextIncidentId(db: Database, dateStamp: string): string {
  const prefix = `INC-${dateStamp}-`;
  const row = db
    .prepare(`SELECT id FROM incidents WHERE id LIKE ? ORDER BY id DESC LIMIT 1`)
    .get(`${prefix}%`) as { id: string } | undefined;
  const n = row ? parseInt(row.id.slice(prefix.length), 10) + 1 : 1;
  return `${prefix}${String(n).padStart(3, '0')}`;
}

export function insertIncident(db: Database, inc: Incident): void {
  db.prepare(
    `INSERT INTO incidents (id, title, status, severity, service, channel_id, triage_thread_ts,
       commander_user_id, comms_user_id, scribe_user_id, started_at, detected_at, resolved_at,
       cost_estimate_usd, is_drill, summary, root_cause, resolution, postmortem_doc)
     VALUES (@id, @title, @status, @severity, @service, @channel_id, @triage_thread_ts,
       @commander_user_id, @comms_user_id, @scribe_user_id, @started_at, @detected_at, @resolved_at,
       @cost_estimate_usd, @is_drill, @summary, @root_cause, @resolution, @postmortem_doc)`,
  ).run(inc as unknown as Record<string, unknown>);
}

export function getIncident(db: Database, id: string): Incident | undefined {
  return db.prepare(`SELECT * FROM incidents WHERE id = ?`).get(id) as Incident | undefined;
}

export function getIncidentByChannel(db: Database, channelId: string): Incident | undefined {
  return db
    .prepare(
      `SELECT * FROM incidents WHERE channel_id = ? AND status NOT IN ('resolved','postmortem_done')
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(channelId) as Incident | undefined;
}

export function updateIncident(db: Database, id: string, patch: Partial<Incident>): void {
  const keys = Object.keys(patch).filter((k) => k !== 'id');
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE incidents SET ${sets} WHERE id = @id`).run({ ...patch, id } as Record<string, unknown>);
}

export function listIncidents(
  db: Database,
  opts: { status?: IncidentStatus | IncidentStatus[]; limit?: number } = {},
): Incident[] {
  const limit = opts.limit ?? 50;
  if (opts.status) {
    const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
    const ph = statuses.map(() => '?').join(',');
    return db
      .prepare(`SELECT * FROM incidents WHERE status IN (${ph}) ORDER BY started_at DESC LIMIT ?`)
      .all(...statuses, limit) as Incident[];
  }
  return db.prepare(`SELECT * FROM incidents ORDER BY started_at DESC LIMIT ?`).all(limit) as Incident[];
}

// ── timeline ─────────────────────────────────────────────────────────────────

export function addTimelineEvent(
  db: Database,
  ev: { incident_id: string; ts: number; kind: TimelineKind; actor?: string | null; content: string },
): void {
  db.prepare(
    `INSERT INTO timeline_events (incident_id, ts, kind, actor, content) VALUES (?, ?, ?, ?, ?)`,
  ).run(ev.incident_id, ev.ts, ev.kind, ev.actor ?? 'sentinel', ev.content);
}

export function getTimeline(db: Database, incidentId: string, sinceTs?: number): TimelineEvent[] {
  if (sinceTs !== undefined) {
    return db
      .prepare(`SELECT * FROM timeline_events WHERE incident_id = ? AND ts >= ? ORDER BY ts ASC, id ASC`)
      .all(incidentId, sinceTs) as TimelineEvent[];
  }
  return db
    .prepare(`SELECT * FROM timeline_events WHERE incident_id = ? ORDER BY ts ASC, id ASC`)
    .all(incidentId) as TimelineEvent[];
}

// ── signals ──────────────────────────────────────────────────────────────────

export function insertSignal(
  db: Database,
  s: {
    channel_id: string;
    message_ts: string;
    user_id: string;
    text: string;
    score: number;
    category: SignalCategory;
    created_at: number;
    service_guess?: string | null;
  },
): number {
  const res = db
    .prepare(
      `INSERT INTO signals (channel_id, message_ts, user_id, text, score, category, created_at, service_guess)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(s.channel_id, s.message_ts, s.user_id, s.text, s.score, s.category, s.created_at, s.service_guess ?? null);
  return Number(res.lastInsertRowid);
}

export function unclusteredSignalsSince(db: Database, sinceTs: number): Signal[] {
  return db
    .prepare(`SELECT * FROM signals WHERE incident_id IS NULL AND created_at >= ? ORDER BY created_at ASC`)
    .all(sinceTs) as Signal[];
}

export function assignSignalsToIncident(db: Database, signalIds: number[], incidentId: string): void {
  const stmt = db.prepare(`UPDATE signals SET incident_id = ? WHERE id = ?`);
  const tx = db.transaction((ids: number[]) => {
    for (const id of ids) stmt.run(incidentId, id);
  });
  tx(signalIds);
}

export function signalsForIncident(db: Database, incidentId: string): Signal[] {
  return db.prepare(`SELECT * FROM signals WHERE incident_id = ?`).all(incidentId) as Signal[];
}

export function hasSignalForMessage(db: Database, channelId: string, messageTs: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM signals WHERE channel_id = ? AND message_ts = ?`)
    .get(channelId, messageTs);
}

// ── interviews ───────────────────────────────────────────────────────────────

export function insertInterview(
  db: Database,
  iv: { incident_id: string; user_id: string; question: string; asked_at: number | null },
): number {
  const res = db
    .prepare(`INSERT INTO interviews (incident_id, user_id, question, asked_at) VALUES (?, ?, ?, ?)`)
    .run(iv.incident_id, iv.user_id, iv.question, iv.asked_at);
  return Number(res.lastInsertRowid);
}

/** Oldest asked-but-unanswered interview for a user (any incident) — matches DM replies. */
export function openInterviewFor(db: Database, userId: string): Interview | undefined {
  return db
    .prepare(
      `SELECT * FROM interviews WHERE user_id = ? AND answer IS NULL AND asked_at IS NOT NULL
       ORDER BY asked_at ASC, id ASC LIMIT 1`,
    )
    .get(userId) as Interview | undefined;
}

/** Next queued (not yet DM'd) question for a user on an incident. */
export function nextQueuedInterview(db: Database, userId: string, incidentId: string): Interview | undefined {
  return db
    .prepare(
      `SELECT * FROM interviews WHERE user_id = ? AND incident_id = ? AND asked_at IS NULL ORDER BY id ASC LIMIT 1`,
    )
    .get(userId, incidentId) as Interview | undefined;
}

export function markInterviewAsked(db: Database, id: number, askedAt: number): void {
  db.prepare(`UPDATE interviews SET asked_at = ? WHERE id = ?`).run(askedAt, id);
}

export function unansweredInterviewCount(db: Database, incidentId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM interviews WHERE incident_id = ? AND answer IS NULL`)
    .get(incidentId) as { n: number };
  return row.n;
}

/** Distinct human authors of war-room messages (postmortem participants). */
export function messageAuthors(db: Database, incidentId: string): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT actor FROM timeline_events
       WHERE incident_id = ? AND kind = 'message' AND actor IS NOT NULL AND actor != 'sentinel'`,
    )
    .all(incidentId) as { actor: string }[];
  return rows.map((r) => r.actor);
}

export function answerInterview(db: Database, id: number, answer: string, answeredAt: number): void {
  db.prepare(`UPDATE interviews SET answer = ?, answered_at = ? WHERE id = ?`).run(answer, answeredAt, id);
}

export function interviewsFor(db: Database, incidentId: string): Interview[] {
  return db.prepare(`SELECT * FROM interviews WHERE incident_id = ? ORDER BY id ASC`).all(incidentId) as Interview[];
}

// ── config ───────────────────────────────────────────────────────────────────

export function getConfigValue(db: Database, key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM config WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value;
}

export function setConfigValue(db: Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}
