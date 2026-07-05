/**
 * Comms engine (spec §6.5): every UPDATE_CADENCE_MINUTES during `active`,
 * draft the update in three registers. Approval buttons send to #stakeholders;
 * nothing is auto-sent externally.
 */
import {
  addTimelineEvent,
  getConfigValue,
  getIncident,
  getTimeline,
  setConfigValue,
  type Database,
  type TimelineEvent,
} from '../db/index.js';
import type { LlmClient } from '../llm/client.js';
import { statusUpdate, type Register } from '../llm/prompts.js';
import type { SlackPort } from '../ports.js';
import { statusUpdateBlocks, type Drafts } from '../slack/blocks/statusUpdate.js';
import { logger } from '../util/logger.js';
import { fmtDuration, now } from '../util/time.js';

const REGISTERS: Register[] = ['engineering', 'executive', 'customer'];

export class CommsEngine {
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private db: Database,
    private slack: SlackPort,
    private llm: LlmClient | null,
    private opts: { cadenceMinutes: number; stakeholderChannel: string },
  ) {}

  get running(): string[] {
    return [...this.timers.keys()];
  }

  start(incidentId: string): void {
    if (this.timers.has(incidentId)) return;
    const interval = setInterval(() => {
      void this.draftNow(incidentId).catch((err) => logger.warn({ err, incidentId }, 'comms draft failed'));
    }, this.opts.cadenceMinutes * 60 * 1000);
    interval.unref?.();
    this.timers.set(incidentId, interval);
  }

  stop(incidentId: string): void {
    const t = this.timers.get(incidentId);
    if (t) clearInterval(t);
    this.timers.delete(incidentId);
  }

  /** Draft all three registers from the timeline window since the last draft. */
  async draftNow(incidentId: string): Promise<Drafts | null> {
    const inc = getIncident(this.db, incidentId);
    if (!inc || !inc.channel_id) return null;
    if (inc.status === 'resolved' || inc.status === 'postmortem_done') {
      this.stop(incidentId);
      return null;
    }

    const sinceStr = getConfigValue(this.db, `lastdraft:${incidentId}`);
    const windowEvents = getTimeline(this.db, incidentId, sinceStr ? parseInt(sinceStr, 10) : undefined);
    const drafts = await this.buildDrafts(inc.id, windowEvents);

    for (const r of REGISTERS) {
      setConfigValue(this.db, `draft:${incidentId}:${r}`, drafts[r]);
    }
    setConfigValue(this.db, `lastdraft:${incidentId}`, String(now()));

    await this.slack.postMessage({
      channel: inc.channel_id,
      text: `📣 Stakeholder update drafts ready — approve to send.`,
      blocks: statusUpdateBlocks(incidentId, drafts, this.opts.cadenceMinutes),
    });
    return drafts;
  }

  private async buildDrafts(incidentId: string, windowEvents: TimelineEvent[]): Promise<Drafts> {
    const inc = getIncident(this.db, incidentId)!;
    const out = {} as Drafts;
    for (const register of REGISTERS) {
      let text: string | null = null;
      if (this.llm) {
        try {
          text = (
            await this.llm.complete({
              system: statusUpdate.system,
              user: statusUpdate.buildUser(windowEvents, register, inc),
              temperature: statusUpdate.temperature,
            })
          ).trim();
        } catch (err) {
          logger.warn({ err, register }, 'status draft LLM failed; using stub');
        }
      }
      out[register] = text ?? this.stubDraft(register, windowEvents);
    }
    return out;
  }

  private stubDraft(register: Register, windowEvents: TimelineEvent[]): string {
    const latest = windowEvents.filter((e) => e.kind !== 'message').slice(-1)[0]?.content ?? 'Investigation ongoing.';
    switch (register) {
      case 'engineering':
        return `Investigation ongoing. Latest: ${latest}`;
      case 'executive':
        return `We are actively working an incident. Impact is being assessed; next update in ~15 minutes.`;
      case 'customer':
        return `Some users may be experiencing degraded service. We're on it and will update shortly.`;
    }
  }

  /** Approve button handler: post the chosen register to #stakeholders. */
  async approveAndSend(incidentId: string, register: Register, approverUserId: string): Promise<boolean> {
    const inc = getIncident(this.db, incidentId);
    const text = getConfigValue(this.db, `draft:${incidentId}:${register}`);
    if (!inc || !text) return false;

    const channelId = (await this.slack.channelIdByName(this.opts.stakeholderChannel)) ?? this.opts.stakeholderChannel;
    const elapsed = fmtDuration(now() - inc.started_at);
    const prefix =
      register === 'customer'
        ? ''
        : `*${inc.id} — ${inc.title}* (${inc.severity ?? 'SEV?'}, ${elapsed} elapsed)\n`;
    await this.slack.postMessage({ channel: channelId, text: `${prefix}${text}` });

    addTimelineEvent(this.db, {
      incident_id: incidentId,
      ts: now(),
      kind: 'update_sent',
      actor: approverUserId,
      content: `${register} update approved and sent to #${this.opts.stakeholderChannel}: ${text.slice(0, 200)}`,
    });
    return true;
  }
}
