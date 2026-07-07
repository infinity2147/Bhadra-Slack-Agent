/**
 * Reporter engine (customer incident reporter): resolves a Slack Connect
 * channel to a tenant, routes a customer's @mention report to the right
 * internal team (LLM P9 with keyword/default fallback), records it, posts a
 * triage card that reuses the existing declare flow, and loops customer-safe
 * updates back to the customer's thread on declare/resolve.
 *
 * Customer-safe: nothing posted into a tenant channel names an internal
 * channel, war room, cost, or incident id.
 */
import {
  getTenantByChannel,
  getTenantReport,
  insertTenantReport,
  nextTenantReportId,
  rulesForTenant,
  setConfigValue,
  tenantReportsForIncident,
  updateTenantReport,
  type Database,
  type Severity,
  type Tenant,
  type TenantReport,
} from '../db/index.js';
import type { LlmClient } from '../llm/client.js';
import { routeTenantReport } from '../llm/prompts.js';
import type { SlackPort } from '../ports.js';
import { tenantReportTriageBlocks } from '../slack/blocks/tenantReport.js';
import { logger } from '../util/logger.js';
import { dateStamp, now } from '../util/time.js';

export interface RouteDecision {
  targetChannelId: string;
  category: string;
  severity: Severity;
  summary: string;
}

export interface ReporterOpts {
  /** Fallback wording when no rules/LLM produce a category. */
  defaultCategory?: string;
}

export class ReporterEngine {
  private channelToTenant = new Map<string, string>();

  constructor(
    private db: Database,
    private slack: SlackPort,
    private llm: LlmClient | null,
    private opts: ReporterOpts = {},
  ) {}

  /** Populate the channel→tenant cache from the DB (call on boot + after add/remove). */
  loadCache(): void {
    this.channelToTenant.clear();
    for (const t of this.db.prepare(`SELECT id, channel_id FROM tenants`).all() as { id: string; channel_id: string }[]) {
      this.channelToTenant.set(t.channel_id, t.id);
    }
  }

  registerTenantChannel(channelId: string, tenantId: string): void {
    this.channelToTenant.set(channelId, tenantId);
  }

  unregister(tenantId: string): void {
    for (const [chan, tid] of this.channelToTenant) if (tid === tenantId) this.channelToTenant.delete(chan);
  }

  isTenantChannel(channelId: string): boolean {
    return this.channelToTenant.has(channelId);
  }

  tenantForChannel(channelId: string): Tenant | undefined {
    if (!this.channelToTenant.has(channelId)) return undefined;
    return getTenantByChannel(this.db, channelId) ?? undefined;
  }

  /** Decide the internal channel + metadata for a report. LLM first, keyword/default fallback. */
  async route(tenant: Tenant, text: string): Promise<RouteDecision> {
    const rules = rulesForTenant(this.db, tenant.id);
    const keyed = rules.map((r, i) => ({ key: `r${i + 1}`, description: r.description, channelId: r.target_channel_id }));

    if (this.llm) {
      try {
        const out = await this.llm.completeJson(
          {
            system: routeTenantReport.system,
            user: routeTenantReport.buildUser(
              text,
              tenant.name,
              tenant.tier,
              keyed.map((k) => ({ key: k.key, description: k.description })),
              tenant.extra_prompt,
            ),
            temperature: routeTenantReport.temperature,
          },
          routeTenantReport.schema,
        );
        const match = keyed.find((k) => k.key === out.route);
        return {
          targetChannelId: match?.channelId ?? tenant.default_channel_id, // untrusted route → default
          category: out.category || this.opts.defaultCategory || 'general',
          severity: out.severity_suggestion,
          summary: out.summary || text.slice(0, 140),
        };
      } catch (err) {
        logger.warn({ err, tenant: tenant.id }, 'LLM routing failed; using keyword fallback');
      }
    }
    return this.keywordRoute(tenant, keyed, text);
  }

  private keywordRoute(
    tenant: Tenant,
    keyed: { key: string; description: string; channelId: string }[],
    text: string,
  ): RouteDecision {
    const lower = text.toLowerCase();
    let best: { channelId: string; score: number } | null = null;
    for (const k of keyed) {
      const terms = k.description.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
      const score = terms.reduce((n, term) => (lower.includes(term) ? n + 1 : n), 0);
      if (score > 0 && (!best || score > best.score)) best = { channelId: k.channelId, score };
    }
    return {
      targetChannelId: best?.channelId ?? tenant.default_channel_id,
      category: this.opts.defaultCategory ?? 'general',
      severity: 'SEV3',
      summary: text.slice(0, 140),
    };
  }

  /** Full intake: route → record → triage card (internal) → customer-safe ack (tenant thread). */
  async handleReport(opts: {
    tenant: Tenant;
    reporterUserId: string;
    text: string;
    threadTs: string;
  }): Promise<TenantReport> {
    const decision = await this.route(opts.tenant, opts.text);
    const id = nextTenantReportId(this.db, dateStamp(now()));
    const report: TenantReport = {
      id,
      tenant_id: opts.tenant.id,
      reporter_user_id: opts.reporterUserId,
      report_text: opts.text,
      source_channel_id: opts.tenant.channel_id,
      source_thread_ts: opts.threadTs,
      routed_channel_id: decision.targetChannelId,
      category: decision.category,
      severity_suggestion: decision.severity,
      status: 'routed',
      incident_id: null,
      created_at: now(),
    };
    insertTenantReport(this.db, report);

    // Reuse the existing declare flow: a preincident record keyed by the report id.
    // sourceChannelId is the INTERNAL routed channel (safe for the war-room link);
    // the customer loop-back is handled separately via tenantReportId.
    setConfigValue(
      this.db,
      `preincident:${id}`,
      JSON.stringify({
        title: decision.summary,
        service: decision.category,
        severity: decision.severity,
        signalIds: [],
        sourceChannelId: decision.targetChannelId,
        tenantReportId: id,
      }),
    );

    await this.slack.postMessage({
      channel: decision.targetChannelId,
      text: `📨 Customer report from ${opts.tenant.name} (${id})`,
      blocks: tenantReportTriageBlocks(report, opts.tenant, decision.summary),
    });

    // Customer-safe acknowledgement in the tenant's thread (no internal names/links).
    await this.slack.postMessage({
      channel: opts.tenant.channel_id,
      thread_ts: opts.threadTs,
      text: `👋 Thanks — we've logged this (ref \`${id}\`) and our team is reviewing it. We'll post updates right here.`,
    });

    return report;
  }

  /** Loop-back: an internal team declared an incident from this report. */
  async onIncidentDeclaredFromReport(reportId: string, incidentId: string): Promise<void> {
    const report = getTenantReport(this.db, reportId);
    if (!report) return;
    updateTenantReport(this.db, reportId, { status: 'linked_incident', incident_id: incidentId });
    await this.slack.postMessage({
      channel: report.source_channel_id,
      thread_ts: report.source_thread_ts,
      text: `🛠️ We've opened an incident for the issue you reported (ref \`${reportId}\`). Our team is actively working on it and we'll update you here.`,
    });
  }

  /** Loop-back: notify every linked tenant thread that the incident resolved. */
  async onIncidentResolved(incidentId: string): Promise<void> {
    for (const report of tenantReportsForIncident(this.db, incidentId)) {
      if (report.status !== 'linked_incident') continue;
      await this.slack.postMessage({
        channel: report.source_channel_id,
        thread_ts: report.source_thread_ts,
        text: `✅ The issue you reported (ref \`${report.id}\`) has been resolved. Thanks for flagging it — please let us know if you still see any trouble.`,
      });
    }
  }
}
