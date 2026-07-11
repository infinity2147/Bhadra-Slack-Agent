import { describe, expect, it } from 'vitest';
import { openDb, insertSignal } from '../src/db/index.js';
import { heuristicClassify, looksLikeSentinelCard, prefilter, SignalEngine } from '../src/engine/signals.js';
import { extractTerms } from '../src/rts/client.js';
import { FakeMcp, FakeSlack } from './helpers/fakes.js';
import { now } from '../src/util/time.js';

function makeEngine(overrides: { mcp?: FakeMcp; threshold?: number } = {}) {
  const db = openDb();
  const slack = new FakeSlack();
  const engine = new SignalEngine({
    db,
    llm: null, // heuristic path — deterministic for tests
    slack,
    mcp: overrides.mcp,
    opts: { windowMinutes: 12, threshold: overrides.threshold ?? 0.5, watchChannelIds: ['C1'] },
  });
  return { db, slack, engine };
}

describe('prefilter', () => {
  it('passes real trouble signals', () => {
    expect(prefilter('checkout feels slow for anyone else?')).toBe(true);
    expect(prefilter('seeing 500s on /cart')).toBe(true);
    expect(prefilter('is search down?')).toBe(true);
    expect(prefilter('requests timing out to payments')).toBe(true);
  });
  it('skips obvious noise', () => {
    expect(prefilter('lunch at noon?')).toBe(false);
    expect(prefilter('great work on the launch 🎉')).toBe(false);
  });
  it('never re-triggers on sentinel cards but allows drill messages', () => {
    expect(looksLikeSentinelCard('⚠️ Possible incident brewing — ...')).toBe(true);
    expect(looksLikeSentinelCard('🎭 DRILL: checkout feels slow?')).toBe(false);
  });
});

describe('heuristicClassify', () => {
  it('maps text to category and service', () => {
    const r = heuristicClassify('seeing 500s on checkout');
    expect(r.category).toBe('errors');
    expect(r.service_guess).toBe('checkout');
  });
});

describe('SignalEngine clustering', () => {
  it('stores signals from watched messages', async () => {
    const { db, engine } = makeEngine();
    await engine.handleMessage({ channelId: 'C1', ts: '1.0', userId: 'U1', text: 'checkout is slow' });
    await engine.handleMessage({ channelId: 'C1', ts: '1.0', userId: 'U1', text: 'checkout is slow' }); // dupe
    await engine.handleMessage({ channelId: 'C1', ts: '2.0', userId: 'U2', text: 'lunch anyone. pizza?' }); // noise
    const count = db.prepare('SELECT COUNT(*) AS n FROM signals').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('does not fire a pre-incident for a single user', async () => {
    const { engine } = makeEngine();
    await engine.handleMessage({ channelId: 'C1', ts: '1.0', userId: 'U1', text: 'checkout is slow' });
    await engine.handleMessage({ channelId: 'C1', ts: '2.0', userId: 'U1', text: 'checkout still slow' });
    expect(await engine.clusterTick()).toBeNull();
  });

  it('fires a pre-incident with 2+ users and posts the triage card threaded in-channel', async () => {
    const mcp = new FakeMcp();
    mcp.when('deploys', 'list_recent_deploys', {
      deploys: [{ id: '#482', service: 'checkout-svc', title: 'fix: connection pooling', author: 'dana', deployed_at: now() - 840 }],
    });
    const { slack, engine } = makeEngine({ mcp });
    await engine.handleMessage({ channelId: 'C1', ts: '1.0', userId: 'U1', text: 'checkout feels slow?' });
    await engine.handleMessage({ channelId: 'C1', ts: '2.0', userId: 'U2', text: 'yeah checkout timeouts here too' });

    const pre = await engine.clusterTick();
    expect(pre).not.toBeNull();
    expect(pre!.service).toContain('checkout');
    expect(pre!.deploy?.id).toBe('#482');
    expect(pre!.signalIds).toHaveLength(2);
    const card = slack.posted[0];
    expect(card.channel).toBe('C1');
    expect(card.thread_ts).toBe('2.0');
    expect(card.text).toContain('⚠️');
    const rendered = JSON.stringify(card.blocks);
    expect(rendered).toContain('Why Sentinel flagged this');
    expect(rendered).toContain('Real-Time Search');
  });

  it('fires offline (LLM down) at the DEFAULT threshold — the drill/degraded path must still declare', async () => {
    // Regression guard: heuristic confidence must sit at/above the default
    // threshold so two humans clear the clustering weight bar (threshold × 2)
    // without the LLM. Previously heuristic=0.6 → 2 signals=1.2 < 1.44 = silent no-fire.
    const { engine } = makeEngine({ threshold: 0.72 }); // llm is null in makeEngine
    await engine.handleMessage({ channelId: 'C1', ts: '1.0', userId: 'U1', text: 'checkout feels slow?' });
    await engine.handleMessage({ channelId: 'C1', ts: '2.0', userId: 'U2', text: 'yeah checkout timeouts here too' });
    const pre = await engine.clusterTick();
    expect(pre).not.toBeNull();
    expect(pre!.signalIds).toHaveLength(2);
  });

  it('respects suppression cooldown and does not re-fire', async () => {
    const { engine } = makeEngine();
    await engine.handleMessage({ channelId: 'C1', ts: '1.0', userId: 'U1', text: 'checkout is slow' });
    await engine.handleMessage({ channelId: 'C1', ts: '2.0', userId: 'U2', text: 'checkout errors here' });
    expect(await engine.clusterTick()).not.toBeNull();
    // same window again — suppressed by the automatic cooldown
    expect(await engine.clusterTick()).toBeNull();
  });

  it('ignores stale signals outside the window', async () => {
    const { db, engine } = makeEngine();
    for (const [ts, user] of [['1.0', 'U1'], ['2.0', 'U2']] as const) {
      insertSignal(db, {
        channel_id: 'C1', message_ts: ts, user_id: user, text: 'checkout slow',
        score: 0.9, category: 'latency', created_at: now() - 60 * 60, service_guess: 'checkout',
      });
    }
    expect(await engine.clusterTick()).toBeNull();
  });
});

describe('extractTerms (RTS fallback filter)', () => {
  it('extracts quoted phrases and bare words, dropping operators', () => {
    const terms = extractTerms('("is it just me" OR "anyone else" OR "500" OR timeout) in:#eng-general after:123');
    expect(terms).toContain('is it just me');
    expect(terms).toContain('anyone else');
    expect(terms).toContain('timeout');
    expect(terms).not.toContain('or');
    expect(terms.find((t) => t.startsWith('in:'))).toBeUndefined();
  });
});
