import { describe, expect, it } from 'vitest';
import {
  openDb,
  insertTenant, getTenant, getTenantByChannel, listTenants, removeTenant,
  insertRoutingRule, rulesForTenant,
  nextTenantReportId, insertTenantReport, getTenantReport, updateTenantReport,
  tenantReportsForIncident,
  type Tenant, type TenantReport,
} from '../src/db/index.js';
import { ReporterEngine } from '../src/engine/reporter.js';
import { LlmClient } from '../src/llm/client.js';
import { FakeSlack } from './helpers/fakes.js';

function tenant(id: string, channelId: string): Tenant {
  return {
    id, name: id.toUpperCase(), channel_id: channelId, slack_team_id: null,
    tier: 'enterprise', default_channel_id: 'C_default', extra_prompt: null, created_at: 1000,
  };
}

function seededDb() {
  const db = openDb();
  insertTenant(db, { ...tenant('acme', 'C_acme'), default_channel_id: 'C_triage' });
  insertRoutingRule(db, { tenant_id: 'acme', target_channel_id: 'C_pay', description: 'payments, billing, refunds, invoices', created_at: 1 });
  insertRoutingRule(db, { tenant_id: 'acme', target_channel_id: 'C_platform', description: 'login, SSO, access, authentication', created_at: 2 });
  return db;
}

describe('tenant DB layer', () => {
  it('stores and resolves tenants by id and channel', () => {
    const db = openDb();
    insertTenant(db, tenant('acme', 'C_acme'));
    expect(getTenant(db, 'acme')!.name).toBe('ACME');
    expect(getTenantByChannel(db, 'C_acme')!.id).toBe('acme');
    expect(getTenantByChannel(db, 'C_missing')).toBeUndefined();
    expect(listTenants(db).map((t) => t.id)).toEqual(['acme']);
  });

  it('stores routing rules and removes tenant + its rules', () => {
    const db = openDb();
    insertTenant(db, tenant('acme', 'C_acme'));
    insertRoutingRule(db, { tenant_id: 'acme', target_channel_id: 'C_pay', description: 'payments billing', created_at: 1 });
    expect(rulesForTenant(db, 'acme')).toHaveLength(1);
    removeTenant(db, 'acme');
    expect(getTenant(db, 'acme')).toBeUndefined();
    expect(rulesForTenant(db, 'acme')).toHaveLength(0);
  });

  it('generates sequential report ids and tracks report lifecycle', () => {
    const db = openDb();
    insertTenant(db, tenant('acme', 'C_acme'));
    expect(nextTenantReportId(db, '20260708')).toBe('TR-20260708-001');
    const report: TenantReport = {
      id: 'TR-20260708-001', tenant_id: 'acme', reporter_user_id: 'UEXT',
      report_text: 'payments failing', source_channel_id: 'C_acme', source_thread_ts: '9.9',
      routed_channel_id: 'C_pay', category: 'payments', severity_suggestion: 'SEV2',
      status: 'routed', incident_id: null, created_at: 5,
    };
    insertTenantReport(db, report);
    expect(nextTenantReportId(db, '20260708')).toBe('TR-20260708-002');
    updateTenantReport(db, report.id, { status: 'linked_incident', incident_id: 'INC-20260708-001' });
    expect(getTenantReport(db, report.id)!.status).toBe('linked_incident');
    expect(tenantReportsForIncident(db, 'INC-20260708-001').map((r) => r.id)).toEqual(['TR-20260708-001']);
  });
});

describe('ReporterEngine.route', () => {
  it('resolves tenants by channel via the cache', () => {
    const db = seededDb();
    const eng = new ReporterEngine(db, new FakeSlack(), null);
    eng.loadCache();
    expect(eng.isTenantChannel('C_acme')).toBe(true);
    expect(eng.isTenantChannel('C_other')).toBe(false);
    expect(eng.tenantForChannel('C_acme')!.id).toBe('acme');
  });

  it('routes via the LLM when available', async () => {
    const db = seededDb();
    const llm = new LlmClient({
      model: 'test',
      transport: async () => JSON.stringify({ route: 'r1', category: 'payments', severity_suggestion: 'SEV2', summary: 'Payments failing.' }),
    });
    const eng = new ReporterEngine(db, new FakeSlack(), llm);
    eng.loadCache();
    const t = eng.tenantForChannel('C_acme')!;
    const res = await eng.route(t, 'our payments are all failing');
    expect(res.targetChannelId).toBe('C_pay'); // r1 → first rule
    expect(res.severity).toBe('SEV2');
  });

  it('coerces an invalid model route to the default channel', async () => {
    const db = seededDb();
    const llm = new LlmClient({
      model: 'test',
      transport: async () => JSON.stringify({ route: 'C_evil', category: 'x', severity_suggestion: 'SEV3', summary: 's' }),
    });
    const eng = new ReporterEngine(db, new FakeSlack(), llm);
    eng.loadCache();
    const res = await eng.route(eng.tenantForChannel('C_acme')!, 'weird thing');
    expect(res.targetChannelId).toBe('C_triage');
  });

  it('falls back to keyword matching when the LLM is unavailable', async () => {
    const db = seededDb();
    const eng = new ReporterEngine(db, new FakeSlack(), null);
    eng.loadCache();
    const login = await eng.route(eng.tenantForChannel('C_acme')!, 'we cannot login, SSO is broken');
    expect(login.targetChannelId).toBe('C_platform');
    const nomatch = await eng.route(eng.tenantForChannel('C_acme')!, 'the moon is bright today');
    expect(nomatch.targetChannelId).toBe('C_triage'); // default
  });
});

describe('ReporterEngine.handleReport', () => {
  it('routes, records the report, posts one triage card, and acks the customer safely', async () => {
    const db = seededDb();
    const eng = new ReporterEngine(db, new FakeSlack(), null); // keyword fallback path
    eng.loadCache();
    const slack = (eng as unknown as { slack: FakeSlack }).slack;
    const t = eng.tenantForChannel('C_acme')!;

    const report = await eng.handleReport({ tenant: t, reporterUserId: 'UEXT', text: 'payments are failing for our users', threadTs: '10.1' });

    expect(report.id).toMatch(/^TR-\d{8}-001$/);
    expect(report.routed_channel_id).toBe('C_pay');
    expect(report.status).toBe('routed');

    const card = slack.posted.find((p) => p.channel === 'C_pay');
    expect(card).toBeDefined();
    const ack = slack.posted.find((p) => p.channel === 'C_acme');
    expect(ack).toBeDefined();
    expect(ack!.thread_ts).toBe('10.1');

    // Customer-safe: ack must not leak internal channel ids or war-room/cost terms.
    expect(ack!.text).not.toMatch(/C_pay|C_triage|war room|\$/i);
    expect(ack!.text).toContain(report.id);

    const raw = db.prepare(`SELECT value FROM config WHERE key = ?`).get(`preincident:${report.id}`) as { value: string };
    const pre = JSON.parse(raw.value);
    expect(pre.tenantReportId).toBe(report.id);
    expect(pre.sourceChannelId).toBe('C_pay'); // internal channel — war-room notice goes here, not the customer
  });
});

describe('ReporterEngine loop-back (customer-safe)', () => {
  it('notifies the customer thread on declare and on resolve without leaking internals', async () => {
    const db = seededDb();
    const eng = new ReporterEngine(db, new FakeSlack(), null);
    eng.loadCache();
    const slack = (eng as unknown as { slack: FakeSlack }).slack;
    const t = eng.tenantForChannel('C_acme')!;
    const report = await eng.handleReport({ tenant: t, reporterUserId: 'UEXT', text: 'login is down', threadTs: '11.0' });

    await eng.onIncidentDeclaredFromReport(report.id, 'INC-20260708-001');
    const updated = getTenantReport(db, report.id)!;
    expect(updated.status).toBe('linked_incident');
    expect(updated.incident_id).toBe('INC-20260708-001');

    const declMsg = slack.posted.filter((p) => p.channel === 'C_acme' && p.thread_ts === '11.0').at(-1)!;
    expect(declMsg.text).toContain(report.id);
    expect(declMsg.text).not.toMatch(/C_platform|C_triage|INC-2026|war room|\$/i);

    await eng.onIncidentResolved('INC-20260708-001');
    const resMsg = slack.posted.filter((p) => p.channel === 'C_acme' && p.thread_ts === '11.0').at(-1)!;
    expect(resMsg.text).toMatch(/resolved/i);
    expect(resMsg.text).not.toMatch(/C_platform|C_triage|INC-2026|\$/i);
  });
});

describe('parseChannelArg', () => {
  it('extracts a channel id from a Slack mention', async () => {
    const { parseChannelArg } = await import('../src/slack/commands.js');
    expect(parseChannelArg('<#C123|payments>')).toBe('C123');
    expect(parseChannelArg('<#C456>')).toBe('C456');
  });
  it('returns a name marker for a plain #name', async () => {
    const { parseChannelArg } = await import('../src/slack/commands.js');
    expect(parseChannelArg('#payments-team')).toEqual({ name: 'payments-team' });
  });
});
