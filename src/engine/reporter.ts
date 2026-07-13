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
  getTenant,
  getTenantIntakeByThread,
  getTenantReport,
  insertTenantIntake,
  insertTenantReport,
  nextTenantReportId,
  rosterForTenant,
  rulesForTenant,
  getConfigValue,
  setConfigValue,
  tenantReportsForIncident,
  updateTenantIntake,
  updateTenantReport,
  type Database,
  type Severity,
  type Tenant,
  type TenantIntake,
  type TenantReport,
  type TenantRosterMember,
} from '../db/index.js';
import type { LlmClient } from '../llm/client.js';
import { generateIntakeQuestions, routeAndStaffTenantReport, routeTenantReport } from '../llm/prompts.js';
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

interface StaffedRouteDecision extends RouteDecision {
  roster: TenantRosterMember[];
}

export interface ReporterOpts {
  /** Fallback wording when no rules/LLM produce a category. */
  defaultCategory?: string;
  /** Tenant admins can override per tenant with /incident tenant intake. */
  defaultIntakeQuestions?: string[];
}

const DEFAULT_INTAKE_QUESTIONS = [
  'What user impact are you seeing, and roughly how many users are affected?',
  'When did this start, and is it still happening right now?',
  'Which workflow, URL, region, or account segment is affected? Any error text helps.',
];

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

  intakeQuestions(tenantId: string): string[] {
    const configured = getConfigValue(this.db, `tenant_intake:${tenantId}`);
    const questions = configured
      ? configured
          .split('\n')
          .map((q) => q.trim())
          .filter(Boolean)
      : [];
    return questions.length > 0 ? questions : this.opts.defaultIntakeQuestions ?? DEFAULT_INTAKE_QUESTIONS;
  }

  async intakeQuestionsFor(tenant: Tenant, initialText: string): Promise<string[]> {
    const configured = getConfigValue(this.db, `tenant_intake:${tenant.id}`);
    if (configured) return this.intakeQuestions(tenant.id);
    if (this.opts.defaultIntakeQuestions) return this.opts.defaultIntakeQuestions;

    if (this.llm) {
      const rules = rulesForTenant(this.db, tenant.id).map((r, i) => ({ key: `r${i + 1}`, description: r.description }));
      try {
        const out = await this.llm.completeJson(
          {
            system: generateIntakeQuestions.system,
            user: generateIntakeQuestions.buildUser(initialText, tenant.name, tenant.tier, rules, tenant.extra_prompt),
            temperature: generateIntakeQuestions.temperature,
          },
          generateIntakeQuestions.schema,
        );
        if (out.questions.length > 0) return out.questions;
      } catch (err) {
        logger.warn({ err, tenant: tenant.id }, 'LLM intake question generation failed; using default questions');
      }
    }
    return DEFAULT_INTAKE_QUESTIONS;
  }

  /** Full intake start: create/reuse per-thread intake and ask the first customer-safe question. */
  async handleReport(opts: {
    tenant: Tenant;
    reporterUserId: string;
    text: string;
    threadTs: string;
  }): Promise<TenantReport | null> {
    const existing = getTenantIntakeByThread(this.db, opts.tenant.channel_id, opts.threadTs);
    if (existing && existing.status === 'collecting') {
      return this.advanceIntake(existing, opts.text);
    }
    if (existing?.report_id) return getTenantReport(this.db, existing.report_id) ?? null;

    const ts = now();
    const questions = await this.intakeQuestionsFor(opts.tenant, opts.text);
    insertTenantIntake(this.db, {
      tenant_id: opts.tenant.id,
      reporter_user_id: opts.reporterUserId,
      source_channel_id: opts.tenant.channel_id,
      source_thread_ts: opts.threadTs,
      initial_text: opts.text,
      questions_json: JSON.stringify(questions),
      answers_json: '[]',
      next_question_index: 0,
      status: 'collecting',
      report_id: null,
      created_at: ts,
      updated_at: ts,
    });

    const [firstQuestion] = questions;
    if (firstQuestion) {
      await this.slack.postMessage({
        channel: opts.tenant.channel_id,
        thread_ts: opts.threadTs,
        text: `Thanks — I need a little more detail so we route this correctly. Please reply in this thread:\n\n${firstQuestion}`,
      });
      return null;
    }
    const intake = getTenantIntakeByThread(this.db, opts.tenant.channel_id, opts.threadTs)!;
    return this.finalizeIntake(intake);
  }

  async handleThreadReply(opts: {
    channelId: string;
    threadTs: string;
    userId: string;
    text: string;
  }): Promise<boolean> {
    const intake = getTenantIntakeByThread(this.db, opts.channelId, opts.threadTs);
    if (!intake || intake.status !== 'collecting') return false;
    return !!(await this.advanceIntake(intake, opts.text));
  }

  private async advanceIntake(intake: TenantIntake, answer: string): Promise<TenantReport | null> {
    const tenant = getTenant(this.db, intake.tenant_id);
    if (!tenant) return null;

    const questions = parseQuestions(intake.questions_json, this.intakeQuestions(tenant.id));
    const answers = parseAnswers(intake.answers_json);
    const question = questions[intake.next_question_index] ?? 'Additional detail';
    answers.push({ question, answer });

    const nextIndex = intake.next_question_index + 1;
    updateTenantIntake(this.db, intake.id, {
      answers_json: JSON.stringify(answers),
      next_question_index: nextIndex,
      updated_at: now(),
    });

    if (nextIndex < questions.length) {
      await this.slack.postMessage({
        channel: intake.source_channel_id,
        thread_ts: intake.source_thread_ts,
        text: questions[nextIndex],
      });
      return null;
    }

    return this.finalizeIntake(getTenantIntakeByThread(this.db, intake.source_channel_id, intake.source_thread_ts)!);
  }

  private async finalizeIntake(intake: TenantIntake): Promise<TenantReport> {
    const tenant = getTenant(this.db, intake.tenant_id);
    if (!tenant) throw new Error(`unknown tenant ${intake.tenant_id}`);

    const transcript = intakeTranscript(intake);
    const staffed = await this.routeAndStaff(tenant, transcript);
    const decision = staffed;
    const id = nextTenantReportId(this.db, dateStamp(now()));
    const matchedRoster = staffed.roster;
    const report: TenantReport = {
      id,
      tenant_id: tenant.id,
      reporter_user_id: intake.reporter_user_id,
      report_text: transcript,
      source_channel_id: tenant.channel_id,
      source_thread_ts: intake.source_thread_ts,
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
        inviteUserIds: matchedRoster.map((m) => m.user_id),
        seedContext: buildSeedContext(tenant, report, decision.summary, matchedRoster),
      }),
    );

    await this.slack.postMessage({
      channel: decision.targetChannelId,
      text: `📨 Customer report from ${tenant.name} (${id})`,
      blocks: tenantReportTriageBlocks(report, tenant, decision.summary, {
        roster: matchedRoster.map((m) => ({ userId: m.user_id, role: m.role })),
      }),
    });

    // Customer-safe acknowledgement in the tenant's thread (no internal names/links).
    await this.slack.postMessage({
      channel: tenant.channel_id,
      thread_ts: intake.source_thread_ts,
      text: `👋 Thanks — we've logged this (ref \`${id}\`) and our team is reviewing it. We'll post updates right here.`,
    });

    updateTenantIntake(this.db, intake.id, { status: 'routed', report_id: id, updated_at: now() });

    return report;
  }

  private matchRoster(tenantId: string, text: string): TenantRosterMember[] {
    const roster = rosterForTenant(this.db, tenantId);
    const lower = text.toLowerCase();
    return roster.filter((member) => {
      const terms = member.match_text
        .toLowerCase()
        .split(/[^a-z0-9_*]+/)
        .filter(Boolean);
      if (terms.length === 0 || terms.includes('*')) return true;
      return terms.some((term) => lower.includes(term));
    });
  }

  async routeAndStaff(tenant: Tenant, transcript: string): Promise<StaffedRouteDecision> {
    const rules = rulesForTenant(this.db, tenant.id);
    const keyedRules = rules.map((r, i) => ({ key: `r${i + 1}`, description: r.description, channelId: r.target_channel_id }));
    const roster = rosterForTenant(this.db, tenant.id);
    const keyedRoster = roster.map((r, i) => ({ key: `u${i + 1}`, member: r }));

    if (this.llm) {
      try {
        const out = await this.llm.completeJson(
          {
            system: routeAndStaffTenantReport.system,
            user: routeAndStaffTenantReport.buildUser(
              transcript,
              tenant.name,
              tenant.tier,
              keyedRules.map((r) => ({ key: r.key, description: r.description })),
              keyedRoster.map((r) => ({ key: r.key, role: r.member.role, matchText: r.member.match_text })),
              tenant.extra_prompt,
            ),
            temperature: routeAndStaffTenantReport.temperature,
          },
          routeAndStaffTenantReport.schema,
        );
        const route = keyedRules.find((r) => r.key === out.route);
        const allowedRoster = new Set(keyedRoster.map((r) => r.key));
        const chosenRoster = (out.roster_keys ?? [])
          .filter((key) => allowedRoster.has(key))
          .map((key) => keyedRoster.find((r) => r.key === key)!.member);
        return {
          targetChannelId: route?.channelId ?? tenant.default_channel_id,
          category: out.category || this.opts.defaultCategory || 'general',
          severity: out.severity_suggestion,
          summary: out.summary || transcript.slice(0, 140),
          roster: chosenRoster,
        };
      } catch (err) {
        logger.warn({ err, tenant: tenant.id }, 'LLM route+staff failed; using deterministic fallback');
      }
    }

    return {
      ...(await this.route(tenant, transcript)),
      roster: this.matchRoster(tenant.id, transcript),
    };
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

function parseAnswers(raw: string): { question: string; answer: string }[] {
  try {
    const parsed = JSON.parse(raw) as { question?: unknown; answer?: unknown }[];
    return parsed
      .filter((a) => typeof a.question === 'string' && typeof a.answer === 'string')
      .map((a) => ({ question: a.question as string, answer: a.answer as string }));
  } catch {
    return [];
  }
}

function parseQuestions(raw: string, fallback: string[]): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown[];
    const questions = parsed.filter((q): q is string => typeof q === 'string' && q.trim().length > 0);
    return questions.length > 0 ? questions : fallback;
  } catch {
    return fallback;
  }
}

function intakeTranscript(intake: TenantIntake): string {
  const answers = parseAnswers(intake.answers_json);
  const lines = [`Initial report: ${intake.initial_text}`];
  for (const a of answers) {
    lines.push(`Q: ${a.question}`);
    lines.push(`A: ${a.answer}`);
  }
  return lines.join('\n');
}

function buildSeedContext(
  tenant: Tenant,
  report: TenantReport,
  summary: string,
  roster: TenantRosterMember[],
): string {
  const rosterLine = roster.length
    ? roster.map((m) => `<@${m.user_id}> (${m.role})`).join(', ')
    : 'No tenant roster members matched this intake.';
  return [
    `Customer: ${tenant.name}${tenant.tier ? ` (${tenant.tier})` : ''}`,
    `Report ref: ${report.id}`,
    `Summary: ${summary}`,
    `Suggested severity: ${report.severity_suggestion ?? 'unset'}`,
    `Category: ${report.category ?? 'general'}`,
    `Matched roster: ${rosterLine}`,
    '',
    report.report_text,
  ].join('\n');
}
