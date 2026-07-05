/** Button/modal handlers (spec §9): the full block-action surface. */
import type { AppContext } from '../context.js';
import { getConfigValue, getIncident, type Severity, type Signal } from '../db/index.js';
import { isDrillSignalUser } from '../engine/drill.js';
import type { Register } from '../llm/prompts.js';
import { logger } from '../util/logger.js';
import { withBoundary, type BoltApp } from './app.js';
import { DECLARE_MODAL_CALLBACK, declareModalView, configInfoView } from './views.js';

interface PreIncidentRecord {
  title: string;
  service: string;
  severity: Severity;
  signalIds: number[];
  sourceChannelId: string;
}

function loadPreIncident(ctx: AppContext, key: string): PreIncidentRecord | null {
  const raw = getConfigValue(ctx.db, `preincident:${key}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PreIncidentRecord;
  } catch {
    return null;
  }
}

function buttonValue(action: unknown): string {
  return ((action as { value?: string }).value ?? '').trim();
}

export function registerActions(app: BoltApp, ctx: AppContext): void {
  // ── triage card ────────────────────────────────────────────────────────────

  app.action(
    'declare_incident',
    withBoundary('action:declare_incident', async ({ ack, body, action }) => {
      await ack();
      const key = buttonValue(action);
      const pre = loadPreIncident(ctx, key);
      const userId = (body as { user: { id: string } }).user.id;
      if (!pre) {
        // Manual declare button (e.g. from home) — open the modal instead.
        return;
      }
      const signals = pre.signalIds.length
        ? (ctx.db
            .prepare(`SELECT * FROM signals WHERE id IN (${pre.signalIds.map(() => '?').join(',')})`)
            .all(...pre.signalIds) as Signal[])
        : [];
      const isDrill = signals.length > 0 && signals.every((s) => isDrillSignalUser(s.user_id));
      const inc = await ctx.core.declare({
        title: pre.title,
        service: pre.service,
        severity: pre.severity,
        reporterId: userId,
        sourceChannelId: pre.sourceChannelId,
        signalIds: pre.signalIds,
        isDrill,
      });
      if (pre.sourceChannelId && inc.channel_id) {
        await ctx.slack.postMessage({
          channel: pre.sourceChannelId,
          text: `🚨 Incident *${inc.id}* declared by <@${userId}> — war room: <#${inc.channel_id}>`,
        });
      }
    }),
  );

  app.action(
    'snooze_signal',
    withBoundary('action:snooze_signal', async ({ ack, body, action }) => {
      await ack();
      const pre = loadPreIncident(ctx, buttonValue(action));
      if (pre) ctx.signals.suppress(pre.service, 15);
      const channel = (body as { channel?: { id: string } }).channel?.id;
      if (channel) {
        await ctx.slack.postMessage({ channel, text: `😴 Snoozed — I'll stay quiet about \`${pre?.service ?? 'this'}\` for 15 minutes.` });
      }
    }),
  );

  app.action(
    'dismiss_signal',
    withBoundary('action:dismiss_signal', async ({ ack, body, action }) => {
      await ack();
      const pre = loadPreIncident(ctx, buttonValue(action));
      if (pre) ctx.signals.suppress(pre.service, 24 * 60);
      const channel = (body as { channel?: { id: string } }).channel?.id;
      if (channel) {
        await ctx.slack.postMessage({
          channel,
          text: `✋ Understood — not an incident. I'll suppress \`${pre?.service ?? 'this'}\` alerts for 24h and weigh similar chatter lower.`,
        });
      }
    }),
  );

  // ── war-room header ────────────────────────────────────────────────────────

  for (const role of ['commander', 'comms', 'scribe'] as const) {
    app.action(
      `claim_role_${role}`,
      withBoundary(`action:claim_role_${role}`, async ({ ack, body, action }) => {
        await ack();
        const userId = (body as { user: { id: string } }).user.id;
        ctx.core.claimRole(buttonValue(action), role, userId);
      }),
    );
  }

  app.action(
    'set_severity',
    withBoundary('action:set_severity', async ({ ack, body, action }) => {
      await ack();
      const selected = (action as { selected_option?: { value?: string } }).selected_option?.value ?? '';
      const [incidentId, sev] = selected.split('|');
      if (!incidentId || !sev) return;
      const userId = (body as { user: { id: string } }).user.id;
      ctx.core.setSeverity(incidentId, sev as Severity, userId);
    }),
  );

  app.action(
    'resolve_incident',
    withBoundary('action:resolve_incident', async ({ ack, body, action }) => {
      await ack();
      const userId = (body as { user: { id: string } }).user.id;
      await ctx.core.resolve(buttonValue(action), userId);
    }),
  );

  // ── comms approvals (human-in-the-loop, spec §6.5) ─────────────────────────

  const registers: [string, Register][] = [
    ['approve_update_eng', 'engineering'],
    ['approve_update_exec', 'executive'],
    ['approve_update_cust', 'customer'],
  ];
  for (const [actionId, register] of registers) {
    app.action(
      actionId,
      withBoundary(`action:${actionId}`, async ({ ack, body, action }) => {
        await ack();
        const incidentId = buttonValue(action);
        const userId = (body as { user: { id: string } }).user.id;
        const ok = await ctx.comms.approveAndSend(incidentId, register, userId);
        const channel = (body as { channel?: { id: string } }).channel?.id;
        if (channel) {
          await ctx.slack.postMessage({
            channel,
            text: ok
              ? `✅ ${register} update approved by <@${userId}> and sent to #${ctx.config.stakeholderChannel}.`
              : `⚠️ Couldn't send — draft missing or incident unknown.`,
          });
        }
      }),
    );
  }

  // ── memory card ────────────────────────────────────────────────────────────

  app.action(
    'open_past_incident',
    withBoundary('action:open_past_incident', async ({ ack, body, action }) => {
      await ack();
      const inc = getIncident(ctx.db, buttonValue(action));
      const channel = (body as { channel?: { id: string } }).channel?.id;
      if (!channel || !inc) return;
      const doc = inc.postmortem_doc ?? `_No postmortem doc on file for ${inc.id}._`;
      await ctx.slack.uploadFile({
        channel,
        filename: `postmortem-${inc.id}.md`,
        content: doc,
        title: `Postmortem ${inc.id} — ${inc.title}`,
      });
    }),
  );

  app.action(
    'page_resolver',
    withBoundary('action:page_resolver', async ({ ack, body, action }) => {
      await ack();
      const [resolverId, incidentId] = buttonValue(action).split('|');
      const userId = (body as { user: { id: string } }).user.id;
      const inc = incidentId ? getIncident(ctx.db, incidentId) : undefined;
      const message = `📟 <@${userId}> is paging you about ${inc ? `*${inc.id} — ${inc.title}*` : 'an active incident'}${inc?.channel_id ? ` — join <#${inc.channel_id}>` : ''}.`;
      if (ctx.mcp) {
        await ctx.mcp.callTool('oncall', 'page', { user: resolverId, message });
      } else {
        await ctx.slack.dm(resolverId, message);
      }
      const channel = (body as { channel?: { id: string } }).channel?.id;
      if (channel) await ctx.slack.postMessage({ channel, text: `📟 Paged <@${resolverId}>.` });
    }),
  );

  // ── App Home ───────────────────────────────────────────────────────────────

  app.action(
    'home_declare',
    withBoundary('action:home_declare', async ({ ack, body, client }) => {
      await ack();
      const triggerId = (body as { trigger_id?: string }).trigger_id;
      if (triggerId) await client.views.open({ trigger_id: triggerId, view: declareModalView() as never });
    }),
  );

  app.action(
    'start_drill',
    withBoundary('action:start_drill', async ({ ack, action }) => {
      await ack();
      const scenario = (buttonValue(action) || 'redis') as 'redis';
      const channelId = await ctx.slack.channelIdByName(ctx.config.demoChannel);
      if (!channelId) {
        logger.warn({ channel: ctx.config.demoChannel }, 'demo channel not found for drill');
        return;
      }
      void ctx.drill.run(scenario, channelId).catch((err) => logger.error({ err }, 'drill failed'));
    }),
  );

  app.action(
    'home_config',
    withBoundary('action:home_config', async ({ ack, body, client }) => {
      await ack();
      const triggerId = (body as { trigger_id?: string }).trigger_id;
      const lines = [
        `*Watched channels:* ${[...ctx.watchChannelIds].map((c) => `<#${c}>`).join(', ') || '_none_'}`,
        `*Default cost rate:* $${ctx.config.costRateDefaultPerMin}/min`,
        `*Update cadence:* every ${ctx.config.updateCadenceMinutes} min`,
        `*Signal window/threshold:* ${ctx.config.signalWindowMinutes} min / ${ctx.config.signalThreshold}`,
      ];
      if (triggerId) await client.views.open({ trigger_id: triggerId, view: configInfoView(lines) as never });
    }),
  );

  // ── declare modal submission ───────────────────────────────────────────────

  app.view(
    DECLARE_MODAL_CALLBACK,
    withBoundary('view:declare_modal', async ({ ack, body, view }) => {
      await ack();
      const state = (view as { state: { values: Record<string, Record<string, { value?: string; selected_option?: { value?: string } }>> } }).state.values;
      const title = state.title_block?.title?.value?.trim() || 'Untitled incident';
      const service = state.service_block?.service?.value?.trim() || undefined;
      const severity = (state.severity_block?.severity?.selected_option?.value ?? 'SEV2') as Severity;
      const userId = (body as { user: { id: string } }).user.id;

      const preKey = (view as { private_metadata?: string }).private_metadata || undefined;
      const pre = preKey ? loadPreIncident(ctx, preKey) : null;

      await ctx.core.declare({
        title,
        service: service ?? pre?.service,
        severity,
        reporterId: userId,
        signalIds: pre?.signalIds,
        sourceChannelId: pre?.sourceChannelId,
      });
    }),
  );
}
