/** /incident slash command family (spec §9). */
import type { AppContext } from '../context.js';
import { getIncidentByChannel, setConfigValue, getConfigValue } from '../db/index.js';
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
