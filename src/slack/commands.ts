/** /incident slash command family (spec §9). */
import type { AppContext } from '../context.js';
import {
  getIncidentByChannel,
  setConfigValue,
  getConfigValue,
  insertTenant,
  insertRoutingRule,
  insertRosterMember,
  getTenant,
  listTenants,
  rosterForTenant,
  rulesForTenant,
  removeRosterMember,
  removeTenant,
} from '../db/index.js';
import type { ScenarioName } from '../engine/drill.js';
import { SCENARIOS } from '../engine/drill.js';
import { logger } from '../util/logger.js';
import { withBoundary, type BoltApp } from './app.js';
import { declareModalView } from './views.js';

const HELP = `*Sentinel IC commands*
\`/incident declare [title]\` — declare an incident (opens a modal)
\`/incident status <text>\` — set the manual status line on this channel's incident
\`/incident resolve\` — resolve this channel's incident
\`/incident drill [redis|deploy|db|payment]\` — run a chaos drill in this channel
\`/incident config cost <service> <usd_per_min>\` — set the 💸 cost rate
\`/incident config watch <#channel>\` — add a channel to the watch list
\`/incident tenant …\` — manage customer report routing (add | rule | prompt | intake | roster | list | remove)
\`/incident help\` — this message`;

export function registerCommands(app: BoltApp, ctx: AppContext): void {
  app.command(
    '/incident',
    withBoundary('command:/incident', async ({ command, ack, client, respond }) => {
      await ack();
      const [sub = 'help', ...rest] = command.text.trim().split(/\s+/);

      switch (sub.toLowerCase()) {
        case 'declare': {
          await client.views.open({
            trigger_id: command.trigger_id,
            view: declareModalView({ title: rest.join(' ') }) as never,
          });
          return;
        }

        case 'status': {
          const inc = getIncidentByChannel(ctx.db, command.channel_id);
          if (!inc) {
            await respond({ response_type: 'ephemeral', text: 'No active incident in this channel.' });
            return;
          }
          const text = rest.join(' ');
          if (!text) {
            await respond({ response_type: 'ephemeral', text: 'Usage: `/incident status <text>`' });
            return;
          }
          ctx.core.setStatusLine(inc.id, text, command.user_id);
          await respond({ response_type: 'in_channel', text: `📣 Status set by <@${command.user_id}>: ${text}` });
          return;
        }

        case 'resolve': {
          const inc = getIncidentByChannel(ctx.db, command.channel_id);
          if (!inc) {
            await respond({ response_type: 'ephemeral', text: 'No active incident in this channel.' });
            return;
          }
          await ctx.core.resolve(inc.id, command.user_id);
          return;
        }

        case 'drill': {
          const scenario = (rest[0]?.toLowerCase() ?? 'redis') as ScenarioName;
          if (!SCENARIOS[scenario]) {
            await respond({
              response_type: 'ephemeral',
              text: `Unknown scenario. Try: ${Object.keys(SCENARIOS).join(', ')}`,
            });
            return;
          }
          await respond({ response_type: 'ephemeral', text: `🎭 Starting \`${scenario}\` drill…` });
          void ctx.drill
            .run(scenario, command.channel_id)
            .catch((err) => logger.error({ err }, 'drill run failed'));
          return;
        }

        case 'config': {
          await handleConfig(ctx, rest, respond);
          return;
        }

        case 'tenant': {
          if (ctx.reporter.isTenantChannel(command.channel_id)) {
            await respond({
              response_type: 'ephemeral',
              text: 'Run tenant admin commands from an internal channel, not a customer channel.',
            });
            return;
          }
          await handleTenant(ctx, rest, respond);
          return;
        }

        default:
          await respond({ response_type: 'ephemeral', text: HELP });
      }
    }),
  );
}

type Respond = (args: { response_type: 'ephemeral' | 'in_channel'; text: string }) => Promise<unknown>;

async function handleConfig(ctx: AppContext, rest: string[], respond: Respond): Promise<void> {
  const [what, ...args] = rest;
  if (what === 'cost' && args.length === 2) {
    const [service, rate] = args;
    const n = parseFloat(rate);
    if (Number.isNaN(n) || n < 0) {
      await respond({ response_type: 'ephemeral', text: 'Rate must be a non-negative number (USD per minute).' });
      return;
    }
    setConfigValue(ctx.db, `cost:${service.toLowerCase()}`, String(n));
    await respond({ response_type: 'ephemeral', text: `💸 Cost rate for \`${service}\` set to $${n}/min.` });
    return;
  }
  if (what === 'watch' && args.length >= 1) {
    // Accept "<#C123|name>", "#name", or a raw id.
    const raw = args[0];
    const mention = raw.match(/^<#([A-Z0-9]+)(?:\|[^>]*)?>$/i);
    const channelId = mention ? mention[1] : await ctx.slack.channelIdByName(raw);
    if (!channelId) {
      await respond({ response_type: 'ephemeral', text: `Couldn't find channel ${raw}.` });
      return;
    }
    await ctx.slack.joinChannel(channelId);
    ctx.watchChannelIds.add(channelId);
    const existing = getConfigValue(ctx.db, 'extra_watch_channels');
    const set = new Set(existing ? existing.split(',') : []);
    set.add(channelId);
    setConfigValue(ctx.db, 'extra_watch_channels', [...set].join(','));
    await respond({ response_type: 'ephemeral', text: `👀 Now watching <#${channelId}> for trouble signals.` });
    return;
  }
  await respond({
    response_type: 'ephemeral',
    text: 'Usage: `/incident config cost <service> <usd_per_min>` or `/incident config watch <#channel>`',
  });
}

/** Parse a channel arg: `<#C123|name>` / `<#C123>` → id; `#name` / `name` → {name} to resolve. */
export function parseChannelArg(raw: string): string | { name: string } {
  const mention = raw.match(/^<#([A-Z0-9]+)(?:\|[^>]*)?>$/i);
  if (mention) return mention[1];
  const clean = raw.replace(/^#/, '');
  if (/^C[A-Z0-9]{6,}$/i.test(clean)) return clean;
  return { name: clean };
}

async function resolveChannel(ctx: AppContext, raw: string): Promise<string | undefined> {
  const parsed = parseChannelArg(raw);
  return typeof parsed === 'string' ? parsed : ctx.slack.channelIdByName(parsed.name);
}

async function handleTenant(ctx: AppContext, rest: string[], respond: Respond): Promise<void> {
  const [action, ...args] = rest;
  const nowS = Math.floor(Date.now() / 1000);

  if (action === 'add' && args.length >= 2) {
    const [slug, chanArg, ...flags] = args;
    const channelId = await resolveChannel(ctx, chanArg);
    if (!channelId) {
      await respond({ response_type: 'ephemeral', text: `Couldn't resolve channel ${chanArg}.` });
      return;
    }
    const tierIdx = flags.indexOf('--tier');
    const defIdx = flags.indexOf('--default');
    const tier = tierIdx >= 0 ? flags[tierIdx + 1] : null;
    const defaultChannelId = defIdx >= 0 ? (await resolveChannel(ctx, flags[defIdx + 1])) ?? channelId : channelId;
    insertTenant(ctx.db, {
      id: slug,
      name: slug.toUpperCase(),
      channel_id: channelId,
      slack_team_id: null,
      tier,
      default_channel_id: defaultChannelId,
      extra_prompt: null,
      created_at: nowS,
    });
    await ctx.slack.joinChannel(channelId);
    ctx.reporter.registerTenantChannel(channelId, slug);
    await respond({
      response_type: 'ephemeral',
      text: `✅ Registered tenant \`${slug}\` on <#${channelId}> (default route <#${defaultChannelId}>).`,
    });
    return;
  }

  if (action === 'rule' && args.length >= 3) {
    const [slug, chanArg, ...descParts] = args;
    if (!getTenant(ctx.db, slug)) {
      await respond({ response_type: 'ephemeral', text: `Unknown tenant \`${slug}\`.` });
      return;
    }
    const target = await resolveChannel(ctx, chanArg);
    if (!target) {
      await respond({ response_type: 'ephemeral', text: `Couldn't resolve channel ${chanArg}.` });
      return;
    }
    insertRoutingRule(ctx.db, { tenant_id: slug, target_channel_id: target, description: descParts.join(' '), created_at: nowS });
    await respond({ response_type: 'ephemeral', text: `✅ Rule added for \`${slug}\` → <#${target}>: _${descParts.join(' ')}_` });
    return;
  }

  if (action === 'prompt' && args.length >= 2) {
    const [slug, ...promptParts] = args;
    const t = getTenant(ctx.db, slug);
    if (!t) {
      await respond({ response_type: 'ephemeral', text: `Unknown tenant \`${slug}\`.` });
      return;
    }
    insertTenant(ctx.db, { ...t, extra_prompt: promptParts.join(' ') });
    await respond({ response_type: 'ephemeral', text: `✅ Guidance updated for \`${slug}\`.` });
    return;
  }

  if (action === 'intake' && args.length >= 1) {
    const [slug, ...questionParts] = args;
    if (!getTenant(ctx.db, slug)) {
      await respond({ response_type: 'ephemeral', text: `Unknown tenant \`${slug}\`.` });
      return;
    }
    if (questionParts.length === 0) {
      const configured = getConfigValue(ctx.db, `tenant_intake:${slug}`);
      await respond({
        response_type: 'ephemeral',
        text: configured
          ? `Configured intake questions for \`${slug}\`:\n${configured
              .split('\n')
              .map((q, i) => `${i + 1}. ${q}`)
              .join('\n')}`
          : `No custom intake questions for \`${slug}\`; defaults are active.`,
      });
      return;
    }
    const questions = questionParts
      .join(' ')
      .split('|')
      .map((q) => q.trim())
      .filter(Boolean);
    if (questions.length === 0) {
      await respond({ response_type: 'ephemeral', text: 'Provide one or more questions separated by `|`.' });
      return;
    }
    setConfigValue(ctx.db, `tenant_intake:${slug}`, questions.join('\n'));
    await respond({ response_type: 'ephemeral', text: `✅ Intake script updated for \`${slug}\` (${questions.length} questions).` });
    return;
  }

  if (action === 'roster' && args.length >= 2) {
    await handleTenantRoster(ctx, args, respond, nowS);
    return;
  }

  if (action === 'list') {
    const tenants = listTenants(ctx.db);
    const lines = tenants.map((t) => {
      const rules = rulesForTenant(ctx.db, t.id)
        .map((r) => `   • <#${r.target_channel_id}>: ${r.description}`)
        .join('\n');
      const roster = rosterForTenant(ctx.db, t.id)
        .map((r) => `   • <@${r.user_id}> (${r.role}): ${r.match_text || '*'}`)
        .join('\n');
      return `*${t.id}* (${t.tier ?? 'standard'}) on <#${t.channel_id}> → default <#${t.default_channel_id}>\nRules:\n${rules || '   • (no rules)'}\nRoster:\n${roster || '   • (no roster)'}`;
    });
    await respond({ response_type: 'ephemeral', text: lines.join('\n\n') || 'No tenants registered.' });
    return;
  }

  if (action === 'remove' && args.length >= 1) {
    removeTenant(ctx.db, args[0]);
    ctx.reporter.unregister(args[0]);
    await respond({ response_type: 'ephemeral', text: `🗑️ Removed tenant \`${args[0]}\`.` });
    return;
  }

  await respond({
    response_type: 'ephemeral',
    text: 'Usage: `/incident tenant add <slug> <#channel> [--tier t] [--default #chan]` · `rule <slug> <#channel> <desc>` · `prompt <slug> <text>` · `intake <slug> q1 | q2` · `roster <slug> add <@user> <role> <keywords>` · `list` · `remove <slug>`',
  });
}

async function handleTenantRoster(ctx: AppContext, args: string[], respond: Respond, nowS: number): Promise<void> {
  const [slug, op, ...rest] = args;
  if (!getTenant(ctx.db, slug)) {
    await respond({ response_type: 'ephemeral', text: `Unknown tenant \`${slug}\`.` });
    return;
  }

  if (op === 'list') {
    const lines = rosterForTenant(ctx.db, slug).map((r) => `<@${r.user_id}> (${r.role}): ${r.match_text || '*'}`);
    await respond({ response_type: 'ephemeral', text: lines.join('\n') || `No roster entries for \`${slug}\`.` });
    return;
  }

  if (op === 'add' && rest.length >= 2) {
    const [userArg, role, ...matchParts] = rest;
    const userId = parseUserArg(userArg);
    if (!userId) {
      await respond({ response_type: 'ephemeral', text: 'Use a Slack user mention like `<@U123>`.' });
      return;
    }
    insertRosterMember(ctx.db, {
      tenant_id: slug,
      user_id: userId,
      role,
      match_text: matchParts.join(' ') || '*',
      created_at: nowS,
    });
    await respond({ response_type: 'ephemeral', text: `✅ Roster entry added for \`${slug}\`: <@${userId}> (${role}).` });
    return;
  }

  if (op === 'remove' && rest.length >= 1) {
    const userId = parseUserArg(rest[0]);
    if (!userId) {
      await respond({ response_type: 'ephemeral', text: 'Use a Slack user mention like `<@U123>`.' });
      return;
    }
    removeRosterMember(ctx.db, slug, userId);
    await respond({ response_type: 'ephemeral', text: `🗑️ Removed <@${userId}> from \`${slug}\` roster.` });
    return;
  }

  await respond({
    response_type: 'ephemeral',
    text: 'Usage: `/incident tenant roster <slug> add <@user> <role> <keywords|*>` · `list` · `remove <@user>`',
  });
}

function parseUserArg(raw: string): string | undefined {
  const mention = raw.match(/^<@([A-Z0-9]+)(?:\|[^>]*)?>$/i);
  if (mention) return mention[1];
  return /^U[A-Z0-9]{3,}$/i.test(raw) ? raw : undefined;
}
