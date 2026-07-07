/** Event handlers: messages, App Home, reactions, assistant surface (spec §6.9). */
import type { AppContext } from '../context.js';
import { addTimelineEvent, getIncidentByChannel, listIncidents } from '../db/index.js';
import { answerIncidentQuestion } from '../engine/assistant.js';
import { logger } from '../util/logger.js';
import { now } from '../util/time.js';
import { withBoundary, type BoltApp } from './app.js';
import { homeBlocks } from './blocks/home.js';

interface MessageLike {
  channel: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
}

export function registerEvents(app: BoltApp, ctx: AppContext): void {
  app.event(
    'message',
    withBoundary('event:message', async ({ event, body }) => {
      const eventId = (body as { event_id?: string }).event_id;
      if (!ctx.deduper.firstTime(eventId)) return; // Slack retry — already handled
      const msg = event as unknown as MessageLike;
      if (msg.subtype && msg.subtype !== 'thread_broadcast') return;
      if (!msg.text) return;

      // DMs: interview replies first, then assistant Q&A.
      if (msg.channel_type === 'im' && msg.user && msg.user !== ctx.botUserId && !msg.bot_id) {
        const consumed = await ctx.postmortem.handleDmReply(msg.user, msg.text);
        if (!consumed) {
          await ctx.slack.setAssistantStatus?.(msg.channel, msg.thread_ts, 'is thinking…');
          const answer = await answerIncidentQuestion(
            { db: ctx.db, llm: ctx.llm, memory: ctx.memory, rts: ctx.rts, channels: [...ctx.watchChannelIds] },
            msg.text,
          );
          await ctx.slack.setAssistantStatus?.(msg.channel, msg.thread_ts, '');
          await ctx.slack.postMessage({ channel: msg.channel, text: answer, thread_ts: msg.thread_ts });
        }
        return;
      }

      // War-room channels: every message becomes timeline (spec §6.2).
      const warIncident = getIncidentByChannel(ctx.db, msg.channel);
      if (warIncident && msg.user && msg.user !== ctx.botUserId) {
        ctx.core.recordMessage(warIncident.id, { userId: msg.user, text: msg.text, ts: Math.floor(parseFloat(msg.ts)) });
        return;
      }

      // Watched channels: the signal pipeline. Skip our own posts — drill
      // messages are fed to the engine directly by DrillEngine.
      if (ctx.watchChannelIds.has(msg.channel) && msg.user && msg.user !== ctx.botUserId && !msg.bot_id) {
        await ctx.signals.handleMessage({ channelId: msg.channel, ts: msg.ts, userId: msg.user, text: msg.text });
      }
    }),
  );

  // 📌 reactions promote messages to pinned timeline highlights (spec §6.2).
  app.event(
    'reaction_added',
    withBoundary('event:reaction_added', async ({ event, client }) => {
      const e = event as unknown as { reaction: string; item: { channel: string; ts: string }; user: string };
      if (e.reaction !== 'pushpin') return;
      const inc = getIncidentByChannel(ctx.db, e.item.channel);
      if (!inc) return;
      await ctx.slack.pin(e.item.channel, e.item.ts).catch(() => {});
      let text = '(message)';
      try {
        const res = await client.conversations.history({ channel: e.item.channel, latest: e.item.ts, inclusive: true, limit: 1 });
        text = res.messages?.[0]?.text ?? text;
      } catch (err) {
        logger.warn({ err }, 'could not fetch pinned message text');
      }
      addTimelineEvent(ctx.db, {
        incident_id: inc.id,
        ts: now(),
        kind: 'action',
        actor: e.user,
        content: `📌 Highlight pinned: ${text.slice(0, 300)}`,
      });
    }),
  );

  app.event(
    'app_home_opened',
    withBoundary('event:app_home_opened', async ({ event, client }) => {
      const e = event as unknown as { user: string; tab?: string };
      if (e.tab === 'messages') return;
      const active = listIncidents(ctx.db, { status: ['detected', 'triage', 'active', 'monitoring'] });
      const recent = listIncidents(ctx.db, { status: ['resolved', 'postmortem_done'], limit: 10 });
      await client.views.publish({
        user_id: e.user,
        view: { type: 'home', blocks: homeBlocks({ active, recent, appName: ctx.config.appName }) } as never,
      });
    }),
  );

  app.event(
    'app_mention',
    withBoundary('event:app_mention', async ({ event }) => {
      const e = event as unknown as { channel: string; text: string; ts: string; thread_ts?: string; user?: string };
      // Tenant report path: a customer @mention in a registered Slack Connect channel.
      const tenant = ctx.reporter.tenantForChannel(e.channel);
      if (tenant && e.user && e.user !== ctx.botUserId) {
        const reportText = e.text.replace(/<@[^>]+>/g, '').trim();
        if (!reportText) return;
        await ctx.reporter.handleReport({
          tenant,
          reporterUserId: e.user,
          text: reportText,
          threadTs: e.thread_ts ?? e.ts,
        });
        return;
      }
      // Otherwise: internal assistant Q&A (unchanged).
      const question = e.text.replace(/<@[^>]+>/g, '').trim();
      if (!question) return;
      const answer = await answerIncidentQuestion(
        { db: ctx.db, llm: ctx.llm, memory: ctx.memory, rts: ctx.rts, channels: [...ctx.watchChannelIds] },
        question,
      );
      await ctx.slack.postMessage({ channel: e.channel, text: answer, thread_ts: e.thread_ts ?? e.ts });
    }),
  );

  app.event(
    'assistant_thread_started',
    withBoundary('event:assistant_thread_started', async ({ event }) => {
      const e = event as unknown as { assistant_thread?: { channel_id?: string; thread_ts?: string } };
      const channel = e.assistant_thread?.channel_id;
      const threadTs = e.assistant_thread?.thread_ts;
      if (!channel) return;
      await ctx.slack.postMessage({
        channel,
        thread_ts: threadTs,
        text: `🛡️ I'm ${ctx.config.appName} — your incident commander. Ask about past incidents, live trouble, or run a drill.`,
      });
      // Slack AI capabilities: seed clickable starter prompts + name the thread,
      // so the assistant surface is a first-class agent, not a plain message bot.
      await ctx.slack.setSuggestedPrompts?.(
        channel,
        threadTs,
        [
          { title: 'What broke last week?', message: 'What incidents happened in the last 7 days?' },
          { title: 'How did we fix the Redis issue?', message: 'How did we resolve the last Redis incident?' },
          { title: 'Anything on fire right now?', message: 'Are there any active incidents or trouble signals right now?' },
          { title: 'Run a Redis drill', message: 'Start a redis drill' },
        ],
        `Ask ${ctx.config.appName} about incidents`,
      );
      await ctx.slack.setAssistantTitle?.(channel, threadTs, `${ctx.config.appName} · Incident Q&A`);
    }),
  );
}
