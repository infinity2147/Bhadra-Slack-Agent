import { describe, expect, it } from 'vitest';
import { openDb, getConfigValue } from '../src/db/index.js';
import { DrillEngine, SCENARIOS, isDrillSignalUser } from '../src/engine/drill.js';
import { SignalEngine } from '../src/engine/signals.js';
import { FakeMcp, FakeSlack } from './helpers/fakes.js';
import { now } from '../src/util/time.js';

describe('drill scenarios', () => {
  it('all four scenarios have a deploy and 3+ prefilter-passing messages', () => {
    for (const [name, s] of Object.entries(SCENARIOS)) {
      expect(s.deploy.service, name).toBeTruthy();
      expect(s.messages.length, name).toBeGreaterThanOrEqual(3);
      for (const m of s.messages) expect(m.text.startsWith('🎭 DRILL'), `${name}: ${m.text}`).toBe(true);
    }
  });

  it('redis scenario matches the spec §11 demo arc', () => {
    const s = SCENARIOS.redis;
    expect(s.deploy.id).toBe('#482');
    expect(s.deploy.service).toBe('checkout-svc');
    expect(s.deploy.title).toBe('fix: connection pooling');
    expect(s.deploy.author).toBe('dana');
    expect(s.messages.map((m) => m.text)).toEqual([
      '🎭 DRILL: checkout feels slow?',
      '🎭 DRILL: yeah seeing timeouts',
      '🎭 DRILL: 500s on /cart',
    ]);
  });
});

describe('DrillEngine end-to-end through the real Signal Engine', () => {
  it('seeds the deploy, posts drill messages, and fires a correlated triage card', async () => {
    const db = openDb();
    const slack = new FakeSlack();
    const mcp = new FakeMcp();
    mcp.when('deploys', 'list_recent_deploys', {
      deploys: [{ id: '#482', service: 'checkout-svc', title: 'fix: connection pooling', author: 'dana', deployed_at: now() - 840 }],
    });
    const signals = new SignalEngine({
      db,
      llm: null,
      slack,
      mcp,
      opts: { windowMinutes: 12, threshold: 0.5, watchChannelIds: ['C1'] },
    });
    const drill = new DrillEngine(slack, signals, mcp, 0 /* collapse delays */);

    await drill.run('redis', 'C1');

    // MCP got the seed + drill-mode calls.
    expect(mcp.calls.some((c) => c.tool === 'seed_deploy')).toBe(true);
    expect(mcp.calls.some((c) => c.tool === 'set_drill_mode')).toBe(true);

    // Triage card fired with deploy correlation, threaded in the source channel.
    const card = slack.posted.find((p) => p.text.includes('⚠️'));
    expect(card).toBeDefined();
    expect(card!.channel).toBe('C1');
    const pre = getConfigValue(db, `preincident:pre-1`);
    expect(pre).toBeDefined();

    // Signals carry simulated distinct reporters, flagged as drill users.
    const rows = db.prepare(`SELECT user_id FROM signals`).all() as { user_id: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => isDrillSignalUser(r.user_id))).toBe(true);
  });
});
