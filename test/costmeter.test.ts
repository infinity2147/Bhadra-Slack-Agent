import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, setConfigValue, getIncident } from '../src/db/index.js';
import { CommsEngine } from '../src/engine/comms.js';
import { CostMeter, estimateCost, ratePerMinFor } from '../src/engine/costMeter.js';
import { IncidentCore } from '../src/engine/incident.js';
import { FakeSlack } from './helpers/fakes.js';

describe('estimateCost', () => {
  it('applies severity multipliers to rate × minutes', () => {
    const base = { ratePerMin: 180, startedAt: 0, nowTs: 600 }; // 10 minutes
    expect(estimateCost({ ...base, severity: 'SEV1' })).toBeCloseTo(1800);
    expect(estimateCost({ ...base, severity: 'SEV2' })).toBeCloseTo(720);
    expect(estimateCost({ ...base, severity: 'SEV3' })).toBeCloseTo(180);
    expect(estimateCost({ ...base, severity: null })).toBeCloseTo(720); // defaults to SEV2
  });

  it('never goes negative', () => {
    expect(estimateCost({ ratePerMin: 180, startedAt: 100, nowTs: 50, severity: 'SEV1' })).toBe(0);
  });
});

describe('ratePerMinFor', () => {
  it('prefers per-service configured rate over the default', () => {
    const db = openDb();
    setConfigValue(db, 'cost:checkout', '400');
    expect(ratePerMinFor(db, 'checkout', 180)).toBe(400);
    expect(ratePerMinFor(db, 'payments', 180)).toBe(180);
    expect(ratePerMinFor(db, null, 180)).toBe(180);
  });
});

describe('CostMeter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('tick updates cost + header, and stop clears the timer', async () => {
    const db = openDb();
    const slack = new FakeSlack();
    const core = new IncidentCore(db, slack, { costRateDefaultPerMin: 180, appName: 'Sentinel' });
    const meter = new CostMeter(db, core, { defaultRatePerMin: 180, tickSeconds: 60 });

    const inc = await core.declare({ title: 'Checkout down', service: 'checkout', severity: 'SEV1' });
    meter.start(inc.id);
    expect(meter.running).toEqual([inc.id]);
    meter.start(inc.id); // idempotent
    expect(meter.running).toEqual([inc.id]);

    const cost = await meter.tick(inc.id);
    expect(cost).toBeGreaterThanOrEqual(0);
    expect(getIncident(db, inc.id)!.cost_estimate_usd).toBe(cost);
    expect(slack.updated.length).toBeGreaterThan(0); // header refreshed

    meter.stop(inc.id);
    expect(meter.running).toEqual([]);
  });

  it('tick self-stops once the incident is resolved', async () => {
    const db = openDb();
    const slack = new FakeSlack();
    const core = new IncidentCore(db, slack, { costRateDefaultPerMin: 180, appName: 'Sentinel' });
    const meter = new CostMeter(db, core, { defaultRatePerMin: 180 });
    const inc = await core.declare({ title: 'x' });
    meter.start(inc.id);
    await core.resolve(inc.id, 'U1');
    await meter.tick(inc.id);
    expect(meter.running).toEqual([]);
  });
});

describe('CommsEngine', () => {
  it('draftNow posts a three-register card and stores drafts; approve sends to stakeholders', async () => {
    const db = openDb();
    const slack = new FakeSlack();
    const core = new IncidentCore(db, slack, { costRateDefaultPerMin: 180, appName: 'Sentinel' });
    const comms = new CommsEngine(db, slack, null, { cadenceMinutes: 15, stakeholderChannel: 'stakeholders' });

    const inc = await core.declare({ title: 'Checkout latency', service: 'checkout' });
    const drafts = await comms.draftNow(inc.id);
    expect(drafts).not.toBeNull();
    expect(drafts!.customer.length).toBeGreaterThan(10);

    const card = slack.posted.find((p) => p.text.includes('📣'));
    expect(card).toBeDefined();

    const sent = await comms.approveAndSend(inc.id, 'executive', 'UAPPROVER');
    expect(sent).toBe(true);
    const external = slack.posted.find((p) => p.channel === 'C_stakeholders');
    expect(external).toBeDefined();
    expect(external!.text).toContain(inc.id);
  });

  it('draftNow refuses to run on resolved incidents', async () => {
    const db = openDb();
    const slack = new FakeSlack();
    const core = new IncidentCore(db, slack, { costRateDefaultPerMin: 180, appName: 'Sentinel' });
    const comms = new CommsEngine(db, slack, null, { cadenceMinutes: 15, stakeholderChannel: 'stakeholders' });
    const inc = await core.declare({ title: 'x' });
    await core.resolve(inc.id, 'U1');
    expect(await comms.draftNow(inc.id)).toBeNull();
  });
});
