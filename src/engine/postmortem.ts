/**
 * Postmortem engine (spec §6.7): after resolution, DM each participant 2-3
 * tailored blameless questions (one at a time), then synthesize interviews +
 * timeline into a postmortem doc, uploaded to the war room.
 */
import {
  answerInterview,
  getIncident,
  getTimeline,
  insertInterview,
  interviewsFor,
  markInterviewAsked,
  messageAuthors,
  nextQueuedInterview,
  openInterviewFor,
  unansweredInterviewCount,
  updateIncident,
  type Database,
  type Incident,
} from '../db/index.js';
import type { LlmClient } from '../llm/client.js';
import { interviewQuestions, postmortemSynthesize } from '../llm/prompts.js';
import type { SlackPort } from '../ports.js';
import { postmortemReadyBlocks } from '../slack/blocks/postmortem.js';
import { logger } from '../util/logger.js';
import { fmtDuration, fmtUsd, now } from '../util/time.js';

const MAX_PARTICIPANTS = 5;

export class PostmortemEngine {
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private db: Database,
    private slack: SlackPort,
    private llm: LlmClient | null,
    private opts: { delaySeconds: number; timeoutSeconds: number },
  ) {}

  /** Called from the incident-resolved hook; kicks off after a short breather. */
  scheduleKickoff(incidentId: string): void {
    const t = setTimeout(() => {
      void this.kickoff(incidentId).catch((err) => logger.error({ err, incidentId }, 'postmortem kickoff failed'));
    }, this.opts.delaySeconds * 1000);
    t.unref?.();
  }

  async kickoff(incidentId: string): Promise<void> {
    const inc = getIncident(this.db, incidentId);
    if (!inc || inc.status !== 'resolved') return;

    const participants = messageAuthors(this.db, incidentId).slice(0, MAX_PARTICIPANTS);
    if (participants.length === 0) {
      await this.finalize(incidentId);
      return;
    }

    const timeline = getTimeline(this.db, incidentId);
    for (const userId of participants) {
      const theirMessages = timeline
        .filter((e) => e.kind === 'message' && e.actor === userId)
        .map((e) => e.content)
        .slice(0, 20);
      const questions = await this.questionsFor(theirMessages, inc.title);
      questions.forEach((q, i) => {
        insertInterview(this.db, {
          incident_id: incidentId,
          user_id: userId,
          question: q,
          asked_at: i === 0 ? now() : null, // first is asked now, rest are queued
        });
      });
      await this.slack
        .dm(
          userId,
          `📋 *Blameless postmortem for ${inc.id} — ${inc.title}*\nThanks for being part of the response. ${questions.length} short questions, one at a time — just reply here.\n\n*Q1:* ${questions[0]}`,
        )
        .catch((err) => logger.warn({ err, userId }, 'interview DM failed'));
    }

    // Safety net: synthesize even if not everyone answers (24h prod, 5min demo).
    const t = setTimeout(() => {
      void this.finalize(incidentId).catch((err) => logger.error({ err }, 'postmortem timeout finalize failed'));
    }, this.opts.timeoutSeconds * 1000);
    t.unref?.();
    this.timers.set(incidentId, t);
  }

  private async questionsFor(participantMessages: string[], incidentTitle: string): Promise<string[]> {
    if (this.llm && participantMessages.length > 0) {
      try {
        const out = await this.llm.completeJson(
          {
            system: interviewQuestions.system,
            user: interviewQuestions.buildUser(participantMessages, incidentTitle),
            temperature: interviewQuestions.temperature,
          },
          interviewQuestions.schema,
        );
        return out.questions;
      } catch (err) {
        logger.warn({ err }, 'interview question LLM failed; using generic questions');
      }
    }
    return [
      'From your point of view, what was the first sign something was wrong?',
      'What information or tooling would have helped you move faster?',
      'What should we change so this class of incident is less likely or less painful?',
    ];
  }

  /**
   * Route a DM reply to its open interview. Returns true when the message was
   * consumed as an interview answer.
   */
  async handleDmReply(userId: string, text: string): Promise<boolean> {
    const open = openInterviewFor(this.db, userId);
    if (!open || !open.incident_id) return false;
    answerInterview(this.db, open.id, text, now());

    const next = nextQueuedInterview(this.db, userId, open.incident_id);
    if (next) {
      markInterviewAsked(this.db, next.id, now());
      await this.slack.dm(userId, `*Next:* ${next.question}`).catch(() => {});
    } else {
      await this.slack.dm(userId, `🙏 That's everything — thank you. The postmortem will include your input.`).catch(() => {});
    }

    if (unansweredInterviewCount(this.db, open.incident_id) === 0) {
      await this.finalize(open.incident_id);
    }
    return true;
  }

  /** Synthesize + publish. Idempotent: only runs while status is `resolved`. */
  async finalize(incidentId: string): Promise<string | null> {
    const inc = getIncident(this.db, incidentId);
    if (!inc || inc.status !== 'resolved') return null;

    const timer = this.timers.get(incidentId);
    if (timer) clearTimeout(timer);
    this.timers.delete(incidentId);

    const timeline = getTimeline(this.db, incidentId);
    const interviews = interviewsFor(this.db, incidentId);

    let doc: string | null = null;
    if (this.llm) {
      try {
        doc = await this.llm.complete({
          system: postmortemSynthesize.system,
          user: postmortemSynthesize.buildUser(inc, timeline, interviews),
          temperature: postmortemSynthesize.temperature,
          maxTokens: 4096,
        });
      } catch (err) {
        logger.warn({ err }, 'postmortem synthesis LLM failed; using template');
      }
    }
    doc ??= templatePostmortem(inc, timeline, interviews);

    updateIncident(this.db, incidentId, { postmortem_doc: doc, status: 'postmortem_done' });

    if (inc.channel_id) {
      // Canvas API availability varies by workspace tier; the .md upload path
      // (files:write) is the reliable spec-mandated fallback.
      await this.slack
        .uploadFile({
          channel: inc.channel_id,
          filename: `postmortem-${inc.id}.md`,
          content: doc,
          title: `Postmortem ${inc.id}`,
        })
        .catch((err) => logger.warn({ err }, 'postmortem upload failed'));
      await this.slack
        .postMessage({
          channel: inc.channel_id,
          text: `📋 Postmortem for *${inc.id}* is ready.`,
          blocks: postmortemReadyBlocks(inc, interviews.filter((i) => i.answer).length),
        })
        .catch(() => {});
    }
    return doc;
  }
}

function templatePostmortem(
  inc: Incident,
  timeline: ReturnType<typeof getTimeline>,
  interviews: ReturnType<typeof interviewsFor>,
): string {
  const duration = inc.resolved_at ? fmtDuration(inc.resolved_at - inc.started_at) : 'unknown';
  const keyEvents = timeline
    .filter((e) => e.kind !== 'message')
    .map((e) => `- ${new Date(e.ts * 1000).toISOString()} — ${e.content}`)
    .join('\n');
  const iv = interviews
    .filter((i) => i.answer)
    .map((i) => `> **Q:** ${i.question}\n> **A (<@${i.user_id}>):** ${i.answer}`)
    .join('\n\n');
  return `# Postmortem: ${inc.id} — ${inc.title}

## Summary
${inc.summary ?? 'See timeline.'}

## Impact
- Duration: ${duration}
- Estimated impact: ${fmtUsd(inc.cost_estimate_usd)}
- Severity: ${inc.severity ?? 'unset'}

## Timeline
${keyEvents || '_No recorded events._'}

## Root cause
${inc.root_cause ?? 'Not yet determined.'}

## What went well
- The incident was detected and a war room was running quickly.

## What went poorly
- See interview answers below for participant observations.

## Action items
- [ ] Assign an owner to confirm the root cause (due: +3 days)
- [ ] Add detection/guardrails so this class of incident pages earlier (due: +2 weeks)

## Lessons
${iv || '_No interview answers were collected before the timeout._'}

---
_Raw timeline available via Sentinel IC._
`;
}
