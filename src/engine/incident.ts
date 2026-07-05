import {
  addTimelineEvent,
  getIncident,
  getTimeline,
  insertIncident,
  nextIncidentId,
  updateIncident,
  assignSignalsToIncident,
  getConfigValue,
  setConfigValue,
  type Database,
  type Incident,
  type IncidentStatus,
  type Severity,
  type TimelineEvent,
} from '../db/index.js';
import type { McpPort, SlackPort } from '../ports.js';
import { logger } from '../util/logger.js';
import { dateStamp, fmtDuration, now, slugify } from '../util/time.js';
import { resolutionBlocks, warroomHeaderBlocks } from '../slack/blocks/warroom.js';

export interface DeclareOpts {
  title: string;
  service?: string;
  severity?: Severity;
  reporterId?: string;
  sourceChannelId?: string;
  signalIds?: number[];
  isDrill?: boolean;
}

export type Role = 'commander' | 'comms' | 'scribe';

export interface ResolveSummary {
  summary: string;
  root_cause: string;
  resolution: string;
}

export type Summarizer = (incident: Incident, timeline: TimelineEvent[]) => Promise<ResolveSummary>;

const LEGAL_TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  detected: ['triage', 'active', 'resolved'],
  triage: ['active', 'resolved'],
  active: ['monitoring', 'resolved'],
  monitoring: ['active', 'resolved'],
  resolved: ['postmortem_done'],
  postmortem_done: [],
};

const ROLE_COLUMNS: Record<Role, 'commander_user_id' | 'comms_user_id' | 'scribe_user_id'> = {
  commander: 'commander_user_id',
  comms: 'comms_user_id',
  scribe: 'scribe_user_id',
};

export interface IncidentCoreOpts {
  costRateDefaultPerMin: number;
  appName: string;
  mcp?: McpPort;
  /** Injected by the LLM layer; falls back to a stub when absent/unavailable. */
  summarizer?: Summarizer;
}

export class IncidentCore {
  readonly db: Database;
  readonly slack: SlackPort;
  private opts: IncidentCoreOpts;
  private declaredHooks: ((incident: Incident) => Promise<void> | void)[] = [];
  private resolvedHooks: ((incident: Incident) => Promise<void> | void)[] = [];

  constructor(db: Database, slack: SlackPort, opts: IncidentCoreOpts) {
    this.db = db;
    this.slack = slack;
    this.opts = opts;
  }

  set summarizer(fn: Summarizer) {
    this.opts.summarizer = fn;
  }

  set mcp(port: McpPort) {
    this.opts.mcp = port;
  }

  onDeclared(fn: (incident: Incident) => Promise<void> | void): void {
    this.declaredHooks.push(fn);
  }

  onResolved(fn: (incident: Incident) => Promise<void> | void): void {
    this.resolvedHooks.push(fn);
  }

  async declare(opts: DeclareOpts): Promise<Incident> {
    const ts = now();
    const id = nextIncidentId(this.db, dateStamp(ts));
    const channelName = `inc-${dateStamp(ts)}-${slugify(opts.service ?? opts.title)}`;
    const channelId = await this.slack.createChannel(channelName);

    const incident: Incident = {
      id,
      title: opts.title,
      status: 'active',
      severity: opts.severity ?? 'SEV2',
      service: opts.service ?? null,
      channel_id: channelId,
      triage_thread_ts: null,
      commander_user_id: null,
      comms_user_id: null,
      scribe_user_id: null,
      started_at: ts,
      detected_at: ts,
      resolved_at: null,
      cost_estimate_usd: 0,
      is_drill: opts.isDrill ? 1 : 0,
      summary: null,
      root_cause: null,
      resolution: null,
      postmortem_doc: null,
    };
    insertIncident(this.db, incident);
    if (opts.signalIds?.length) assignSignalsToIncident(this.db, opts.signalIds, id);
    addTimelineEvent(this.db, {
      incident_id: id,
      ts,
      kind: 'status_change',
      actor: opts.reporterId ?? 'sentinel',
      content: `Incident declared: ${opts.title}${opts.isDrill ? ' (🎭 DRILL)' : ''}`,
    });

    // Invite reporter + on-call (best effort).
    const invitees = new Set<string>();
    if (opts.reporterId) invitees.add(opts.reporterId);
    if (this.opts.mcp && incident.service) {
      try {
        const oncall = (await this.opts.mcp.callTool('oncall', 'who_is_oncall', {
          service: incident.service,
        })) as { user_id?: string } | undefined;
        if (oncall?.user_id) invitees.add(oncall.user_id);
      } catch (err) {
        logger.warn({ err }, 'oncall lookup failed; continuing without');
      }
    }
    if (invitees.size > 0) {
      await this.slack.inviteUsers(channelId, [...invitees]).catch((err) =>
        logger.warn({ err }, 'invite failed; continuing'),
      );
    }

    // War-room header: post, pin, remember its ts for live updates.
    const header = await this.slack.postMessage({
      channel: channelId,
      text: `🚨 ${id} — ${opts.title}`,
      blocks: warroomHeaderBlocks(incident, { costUsd: 0, elapsed: 0 }),
    });
    await this.slack.pin(channelId, header.ts).catch((err) => logger.warn({ err }, 'pin failed'));
    setConfigValue(this.db, `header:${id}`, `${header.channel}:${header.ts}`);

    await this.addDefaultBookmarks(incident).catch((err) => logger.warn({ err }, 'bookmarks failed'));

    for (const hook of this.declaredHooks) {
      try {
        await hook(getIncident(this.db, id)!);
      } catch (err) {
        logger.error({ err }, 'onDeclared hook failed');
      }
    }
    return getIncident(this.db, id)!;
  }

  private async addDefaultBookmarks(incident: Incident): Promise<void> {
    if (!incident.channel_id) return;
    let dashboardUrl = 'https://observability.example.com/dashboards';
    if (this.opts.mcp && incident.service) {
      try {
        const res = (await this.opts.mcp.callTool('observability', 'get_dashboard_url', {
          service: incident.service,
        })) as { url?: string };
        if (res?.url) dashboardUrl = res.url;
      } catch {
        /* keep placeholder */
      }
    }
    const svc = incident.service ?? 'general';
    await this.slack.addBookmark(incident.channel_id, 'Runbook', `https://runbooks.example.com/${svc}`, '📘');
    await this.slack.addBookmark(incident.channel_id, 'Dashboard', dashboardUrl, '📈');
    await this.slack.addBookmark(
      incident.channel_id,
      'Timeline',
      `https://sentinel.example.com/incidents/${incident.id}/timeline`,
      '🕐',
    );
  }

  transition(id: string, to: IncidentStatus, actor: string): Incident {
    const inc = this.mustGet(id);
    if (!LEGAL_TRANSITIONS[inc.status].includes(to)) {
      throw new Error(`illegal transition ${inc.status} → ${to} for ${id}`);
    }
    updateIncident(this.db, id, { status: to });
    addTimelineEvent(this.db, {
      incident_id: id,
      ts: now(),
      kind: 'status_change',
      actor,
      content: `Status: ${inc.status} → ${to}`,
    });
    if (inc.channel_id) {
      void this.slack
        .postMessage({ channel: inc.channel_id, text: `🔁 Status changed: *${inc.status}* → *${to}* (by <@${actor}>)` })
        .catch((err) => logger.warn({ err }, 'status post failed'));
    }
    return this.mustGet(id);
  }

  claimRole(id: string, role: Role, userId: string): Incident {
    const col = ROLE_COLUMNS[role];
    updateIncident(this.db, id, { [col]: userId } as Partial<Incident>);
    addTimelineEvent(this.db, {
      incident_id: id,
      ts: now(),
      kind: 'action',
      actor: userId,
      content: `<@${userId}> claimed role: ${role}`,
    });
    void this.refreshHeader(id).catch(() => {});
    return this.mustGet(id);
  }

  setSeverity(id: string, severity: Severity, actor: string): Incident {
    updateIncident(this.db, id, { severity });
    addTimelineEvent(this.db, {
      incident_id: id,
      ts: now(),
      kind: 'action',
      actor,
      content: `Severity set to ${severity}`,
    });
    void this.refreshHeader(id).catch(() => {});
    return this.mustGet(id);
  }

  recordMessage(id: string, msg: { userId: string; text: string; ts?: number }): void {
    addTimelineEvent(this.db, {
      incident_id: id,
      ts: msg.ts ?? now(),
      kind: 'message',
      actor: msg.userId,
      content: msg.text,
    });
  }

  setStatusLine(id: string, text: string, actor: string): void {
    setConfigValue(this.db, `statusline:${id}`, text);
    addTimelineEvent(this.db, { incident_id: id, ts: now(), kind: 'action', actor, content: `Manual status: ${text}` });
    void this.refreshHeader(id).catch(() => {});
  }

  /** Re-render the pinned war-room header (used by cost meter tick + role/severity changes). */
  async refreshHeader(id: string, costUsd?: number): Promise<void> {
    const inc = this.mustGet(id);
    const loc = getConfigValue(this.db, `header:${id}`);
    if (!loc || !inc.channel_id) return;
    const [channel, ts] = splitHeaderLoc(loc);
    const elapsed = (inc.resolved_at ?? now()) - inc.started_at;
    await this.slack.updateMessage({
      channel,
      ts,
      text: `🚨 ${inc.id} — ${inc.title}`,
      blocks: warroomHeaderBlocks(inc, {
        costUsd: costUsd ?? inc.cost_estimate_usd,
        elapsed,
        statusLine: getConfigValue(this.db, `statusline:${id}`),
      }),
    });
  }

  async resolve(id: string, actor: string): Promise<Incident> {
    const before = this.mustGet(id);
    if (before.status === 'resolved' || before.status === 'postmortem_done') return before;
    this.transition(id, 'resolved', actor);
    const resolvedAt = now();
    updateIncident(this.db, id, { resolved_at: resolvedAt });

    const timeline = getTimeline(this.db, id);
    let summary: ResolveSummary;
    if (this.opts.summarizer) {
      try {
        summary = await this.opts.summarizer(this.mustGet(id), timeline);
      } catch (err) {
        logger.warn({ err }, 'LLM resolve summary failed; using stub');
        summary = stubSummary(before);
      }
    } else {
      summary = stubSummary(before);
    }
    updateIncident(this.db, id, {
      summary: summary.summary,
      root_cause: summary.root_cause,
      resolution: summary.resolution,
    });

    const inc = this.mustGet(id);
    if (inc.channel_id) {
      await this.slack
        .postMessage({
          channel: inc.channel_id,
          text: `✅ ${inc.id} resolved — ${summary.summary}`,
          blocks: resolutionBlocks(inc, fmtDuration(resolvedAt - inc.started_at)),
        })
        .catch((err) => logger.warn({ err }, 'resolution card failed'));
    }
    await this.refreshHeader(id).catch(() => {});

    for (const hook of this.resolvedHooks) {
      try {
        await hook(inc);
      } catch (err) {
        logger.error({ err }, 'onResolved hook failed');
      }
    }
    return this.mustGet(id);
  }

  private mustGet(id: string): Incident {
    const inc = getIncident(this.db, id);
    if (!inc) throw new Error(`unknown incident ${id}`);
    return inc;
  }
}

function splitHeaderLoc(loc: string): [string, string] {
  const i = loc.indexOf(':');
  return [loc.slice(0, i), loc.slice(i + 1)];
}

function stubSummary(inc: Incident): ResolveSummary {
  return {
    summary: `${inc.title} — resolved.`,
    root_cause: 'Root cause pending postmortem analysis.',
    resolution: 'Mitigated by the response team.',
  };
}
