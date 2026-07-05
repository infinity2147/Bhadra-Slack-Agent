import { describe, expect, it } from 'vitest';
import {
  addTimelineEvent,
  answerInterview,
  assignSignalsToIncident,
  getConfigValue,
  getIncident,
  getTimeline,
  insertIncident,
  insertInterview,
  insertSignal,
  nextIncidentId,
  openDb,
  openInterviewFor,
  setConfigValue,
  unclusteredSignalsSince,
  updateIncident,
  type Incident,
} from '../src/db/index.js';
import { cosineSimilarity, storeEmbedding, topKSimilar } from '../src/db/embeddings.js';

function blankIncident(id: string): Incident {
  return {
    id,
    title: 'Checkout latency',
    status: 'detected',
    severity: null,
    service: 'checkout',
    channel_id: null,
    triage_thread_ts: null,
    commander_user_id: null,
    comms_user_id: null,
    scribe_user_id: null,
    started_at: 1751760000,
    detected_at: 1751760000,
    resolved_at: null,
    cost_estimate_usd: 0,
    is_drill: 0,
    summary: null,
    root_cause: null,
    resolution: null,
    postmortem_doc: null,
  };
}

describe('db', () => {
  it('generates sequential incident ids per day', () => {
    const db = openDb();
    expect(nextIncidentId(db, '20260706')).toBe('INC-20260706-001');
    insertIncident(db, blankIncident('INC-20260706-001'));
    expect(nextIncidentId(db, '20260706')).toBe('INC-20260706-002');
    expect(nextIncidentId(db, '20260707')).toBe('INC-20260707-001');
  });

  it('persists incident updates and timeline events', () => {
    const db = openDb();
    insertIncident(db, blankIncident('INC-20260706-001'));
    updateIncident(db, 'INC-20260706-001', { status: 'active', severity: 'SEV2' });
    const inc = getIncident(db, 'INC-20260706-001')!;
    expect(inc.status).toBe('active');
    expect(inc.severity).toBe('SEV2');

    addTimelineEvent(db, { incident_id: inc.id, ts: 1, kind: 'status_change', content: 'declared' });
    addTimelineEvent(db, { incident_id: inc.id, ts: 2, kind: 'message', actor: 'U1', content: 'hi' });
    const tl = getTimeline(db, inc.id);
    expect(tl.map((e) => e.kind)).toEqual(['status_change', 'message']);
    expect(tl[1].actor).toBe('U1');
  });

  it('tracks unclustered signals and assignment', () => {
    const db = openDb();
    const id1 = insertSignal(db, {
      channel_id: 'C1', message_ts: '1.0', user_id: 'U1', text: 'checkout slow',
      score: 0.8, category: 'latency', created_at: 100, service_guess: 'checkout',
    });
    insertSignal(db, {
      channel_id: 'C1', message_ts: '2.0', user_id: 'U2', text: 'old noise',
      score: 0.6, category: 'errors', created_at: 10,
    });
    expect(unclusteredSignalsSince(db, 50).map((s) => s.id)).toEqual([id1]);
    insertIncident(db, blankIncident('INC-20260706-001'));
    assignSignalsToIncident(db, [id1], 'INC-20260706-001');
    expect(unclusteredSignalsSince(db, 50)).toHaveLength(0);
  });

  it('matches DM replies to the oldest open interview', () => {
    const db = openDb();
    insertIncident(db, blankIncident('INC-20260706-001'));
    const a = insertInterview(db, { incident_id: 'INC-20260706-001', user_id: 'U1', question: 'q1', asked_at: 1 });
    insertInterview(db, { incident_id: 'INC-20260706-001', user_id: 'U1', question: 'q2', asked_at: 2 });
    expect(openInterviewFor(db, 'U1')!.id).toBe(a);
    answerInterview(db, a, 'because redis', 5);
    expect(openInterviewFor(db, 'U1')!.question).toBe('q2');
  });

  it('stores config key-values with upsert', () => {
    const db = openDb();
    setConfigValue(db, 'cost:checkout', '400');
    setConfigValue(db, 'cost:checkout', '500');
    expect(getConfigValue(db, 'cost:checkout')).toBe('500');
    expect(getConfigValue(db, 'missing')).toBeUndefined();
  });
});

describe('embeddings', () => {
  it('cosine similarity of identical vectors is 1', () => {
    const v = new Float32Array([0.1, 0.5, -0.3]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it('topK returns nearest incidents above threshold, ordered', () => {
    const db = openDb();
    for (const id of ['INC-A', 'INC-B', 'INC-C']) insertIncident(db, blankIncident(id));
    storeEmbedding(db, 'INC-A', new Float32Array([1, 0, 0]));
    storeEmbedding(db, 'INC-B', new Float32Array([0.9, 0.1, 0]));
    storeEmbedding(db, 'INC-C', new Float32Array([0, 1, 0]));
    const res = topKSimilar(db, new Float32Array([1, 0, 0]), 3, 0.6);
    expect(res.map((r) => r.incidentId)).toEqual(['INC-A', 'INC-B']);
    expect(res[0].score).toBeGreaterThan(res[1].score);
  });
});
