import { describe, expect, it } from 'vitest';
import { IncidentCore } from '../src/engine/incident.js';
import { getTimeline, openDb } from '../src/db/index.js';
import { FakeMcp, FakeSlack } from './helpers/fakes.js';

function makeCore(overrides: Partial<ConstructorParameters<typeof IncidentCore>[2]> = {}) {
  const db = openDb();
  const slack = new FakeSlack();
  const core = new IncidentCore(db, slack, {
    costRateDefaultPerMin: 180,
    appName: 'Sentinel IC',
    ...overrides,
  });
  return { db, slack, core };
}

describe('IncidentCore', () => {
  it('declare creates a channel, posts + pins header, logs timeline', async () => {
    const { db, slack, core } = makeCore();
    const inc = await core.declare({ title: 'Checkout latency spike', service: 'checkout', reporterId: 'U1' });

    expect(inc.id).toMatch(/^INC-\d{8}-001$/);
    expect(inc.status).toBe('active');
    expect(slack.channels[0]).toMatch(/^inc-\d{8}-checkout$/);
    expect(slack.posted[0].text).toContain(inc.id);
    expect(slack.posted[1].text).toContain('Live incident timeline');
    expect(JSON.stringify(slack.posted[1].blocks)).toContain('Incident declared');
    expect(slack.calls.some((c) => c.method === 'pin')).toBe(true);
    expect(slack.calls.filter((c) => c.method === 'addBookmark')).toHaveLength(3);
    const tl = getTimeline(db, inc.id);
    expect(tl[0].kind).toBe('status_change');
  });

  it('invites on-call from MCP when service known', async () => {
    const mcp = new FakeMcp();
    mcp.when('oncall', 'who_is_oncall', { user_id: 'UONCALL' });
    const { slack, core } = makeCore({ mcp });
    await core.declare({ title: 'DB errors', service: 'payments', reporterId: 'U1' });
    const invite = slack.calls.find((c) => c.method === 'inviteUsers');
    expect((invite!.args as { userIds: string[] }).userIds.sort()).toEqual(['U1', 'UONCALL']);
  });

  it('enforces legal state transitions', async () => {
    const { core } = makeCore();
    const inc = await core.declare({ title: 'x' });
    core.transition(inc.id, 'monitoring', 'U1');
    core.transition(inc.id, 'active', 'U1');
    expect(() => core.transition(inc.id, 'postmortem_done', 'U1')).toThrow(/illegal transition/);
    core.transition(inc.id, 'resolved', 'U1');
    core.transition(inc.id, 'postmortem_done', 'U1');
    expect(() => core.transition(inc.id, 'active', 'U1')).toThrow(/illegal transition/);
  });

  it('claims roles and re-renders the header', async () => {
    const { slack, core } = makeCore();
    const inc = await core.declare({ title: 'x' });
    const updated = core.claimRole(inc.id, 'commander', 'U9');
    expect(updated.commander_user_id).toBe('U9');
    // allow the fire-and-forget header refresh to flush
    await new Promise((r) => setTimeout(r, 0));
    expect(slack.updated.length).toBeGreaterThan(0);
  });

  it('updates the live timeline card when war-room messages are recorded', async () => {
    const { slack, core } = makeCore();
    const inc = await core.declare({ title: 'Checkout latency spike', service: 'checkout' });
    core.recordMessage(inc.id, { userId: 'U2', text: 'Restarted the Redis pool' });

    await new Promise((r) => setTimeout(r, 0));
    const timelineUpdate = slack.updated.find((u) => u.text.includes('Live incident timeline'));
    expect(timelineUpdate).toBeDefined();
    expect(JSON.stringify(timelineUpdate!.blocks)).toContain('Restarted the Redis pool');
  });

  it('resolve stamps resolved_at, uses summarizer, posts resolution card, fires hooks', async () => {
    const { core, slack } = makeCore({
      summarizer: async () => ({ summary: 'S', root_cause: 'R', resolution: 'F' }),
    });
    let hookFired = false;
    core.onResolved(() => {
      hookFired = true;
    });
    const inc = await core.declare({ title: 'Redis pool exhaustion', service: 'checkout' });
    core.recordMessage(inc.id, { userId: 'U1', text: 'restarting the pool' });
    const resolved = await core.resolve(inc.id, 'U1');

    expect(resolved.status).toBe('resolved');
    expect(resolved.resolved_at).not.toBeNull();
    expect(resolved.summary).toBe('S');
    expect(resolved.root_cause).toBe('R');
    expect(hookFired).toBe(true);
    expect(slack.posted.some((p) => p.text.includes('resolved'))).toBe(true);
  });

  it('resolve falls back to stub summary when summarizer throws', async () => {
    const { core } = makeCore({
      summarizer: async () => {
        throw new Error('llm down');
      },
    });
    const inc = await core.declare({ title: 'Search errors' });
    const resolved = await core.resolve(inc.id, 'U1');
    expect(resolved.summary).toContain('Search errors');
  });

  it('resolve is idempotent', async () => {
    const { core } = makeCore();
    const inc = await core.declare({ title: 'x' });
    await core.resolve(inc.id, 'U1');
    const again = await core.resolve(inc.id, 'U1');
    expect(again.status).toBe('resolved');
  });
});
