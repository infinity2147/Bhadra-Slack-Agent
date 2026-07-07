/**
 * Sentinel IC bootstrap: Bolt app, engines, MCP hub, schedulers (spec §2).
 */
import { config } from './config.js';
import type { AppContext } from './context.js';
import { openDb, getConfigValue, signalsForIncident } from './db/index.js';
import { CommsEngine } from './engine/comms.js';
import { CostMeter } from './engine/costMeter.js';
import { DrillEngine } from './engine/drill.js';
import { IncidentCore } from './engine/incident.js';
import { MemoryEngine } from './engine/memory.js';
import { PostmortemEngine } from './engine/postmortem.js';
import { SignalEngine } from './engine/signals.js';
import { LlmClient } from './llm/client.js';
import { McpHub } from './mcp/hub.js';
import type { DeployRecord } from './ports.js';
import { RtsClient } from './rts/client.js';
import { createSlackApp, EventDeduper } from './slack/app.js';
import { registerActions } from './slack/actions.js';
import { registerCommands } from './slack/commands.js';
import { registerEvents } from './slack/events.js';
import { WebSlackPort, type SlackWebApi } from './slack/port.js';
import type { Block } from './slack/blocks/warroom.js';
import { logger } from './util/logger.js';
import { fmtDuration, now } from './util/time.js';

async function main(): Promise<void> {
  if (!config.slackBotToken || (config.slackMode === 'socket' && !config.slackAppToken)) {
    logger.error(
      'Missing Slack credentials. Copy .env.example → .env and set SLACK_BOT_TOKEN + SLACK_APP_TOKEN (socket mode). See README.',
    );
    process.exit(1);
  }

  const db = openDb(config.dbPath);
  const app = createSlackApp(config);
  const web = app.client as unknown as SlackWebApi;
  const slack = new WebSlackPort(web);
  const rts = new RtsClient(web);
  const llm = config.llmApiKey
    ? new LlmClient({
        apiKey: config.llmApiKey,
        model: config.llmModel,
        provider: config.llmProvider,
        baseUrl: config.openaiBaseUrl,
      })
    : null;
  if (llm) logger.info({ provider: config.llmProvider, model: config.llmModel }, 'LLM provider configured');
  else logger.warn('No LLM API key set — running with deterministic fallback copy (no LLM drafting)');

  // MCP hub (mock servers for the demo; swap real server commands via config).
  let mcp: McpHub | undefined;
  if (config.mockMcp) {
    mcp = new McpHub();
    await mcp.connectAll();
    mcp.onPage = async (user, message) => {
      await slack.dm(user, message);
    };
  }

  // Engines.
  const core = new IncidentCore(db, slack, {
    costRateDefaultPerMin: config.costRateDefaultPerMin,
    appName: config.appName,
    mcp,
  });
  const memory = new MemoryEngine(db, llm, rts);
  const comms = new CommsEngine(db, slack, llm, {
    cadenceMinutes: config.updateCadenceMinutes,
    stakeholderChannel: config.stakeholderChannel,
  });
  const costMeter = new CostMeter(db, core, { defaultRatePerMin: config.costRateDefaultPerMin });
  const postmortem = new PostmortemEngine(db, slack, llm, {
    delaySeconds: config.postmortemDelaySeconds,
    timeoutSeconds: config.postmortemTimeoutSeconds,
  });

  // Resolve watch channels (names → IDs) and join them.
  const watchChannelIds = new Set<string>();
  const extra = getConfigValue(db, 'extra_watch_channels');
  const wanted = [...config.watchChannels, ...(extra ? extra.split(',') : [])];
  for (const name of wanted) {
    const id = await slack.channelIdByName(name);
    if (id) {
      watchChannelIds.add(id);
      await slack.joinChannel(id);
    } else {
      logger.warn({ channel: name }, 'watch channel not found (create it or fix WATCH_CHANNELS)');
    }
  }

  const signals = new SignalEngine({
    db,
    llm,
    slack,
    mcp,
    rts,
    opts: {
      windowMinutes: config.signalWindowMinutes,
      threshold: config.signalThreshold,
      watchChannelIds: [...watchChannelIds],
    },
  });
  signals.similarLineProvider = (pre) => memory.similarLine(`${pre.title}. ${pre.service}. ${pre.one_line}`);

  const drill = new DrillEngine(slack, signals, mcp);

  // LLM summarizer for resolution cards (P4).
  if (llm) {
    const { resolveSummarize } = await import('./llm/prompts.js');
    core.summarizer = async (_incident, timeline) =>
      llm.completeJson(
        {
          system: resolveSummarize.system,
          user: resolveSummarize.buildUser(timeline),
          temperature: resolveSummarize.temperature,
        },
        resolveSummarize.schema,
      );
  }

  // Lifecycle hooks: declare → memory card + MCP context card + schedulers.
  core.onDeclared(async (incident) => {
    comms.start(incident.id);
    costMeter.start(incident.id);
    if (!incident.channel_id) return;

    const card = await memory.memoryCard(incident);
    if (card) {
      await slack.postMessage({ channel: incident.channel_id, text: '🧠 Institutional memory', blocks: card });
    }

    if (mcp && incident.service) {
      try {
        const [deploysRes, errRate, latency] = await Promise.all([
          mcp.callTool('deploys', 'list_recent_deploys', { minutes: 60 }) as Promise<{ deploys?: DeployRecord[] }>,
          mcp.callTool('observability', 'get_error_rate', { service: incident.service }) as Promise<{ error_rate_pct?: number }>,
          mcp.callTool('observability', 'get_latency_p95', { service: incident.service }) as Promise<{ latency_p95_ms?: number }>,
        ]);
        const deployLines = (deploysRes.deploys ?? [])
          .slice(0, 3)
          .map((d) => `• \`${d.service} ${d.id}\` "${d.title}" by @${d.author} — ${fmtDuration(now() - d.deployed_at)} ago`)
          .join('\n');
        const blocks: Block[] = [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `📊 *Live context* (via MCP)\n*Error rate:* ${errRate.error_rate_pct ?? '?'}% · *p95 latency:* ${latency.latency_p95_ms ?? '?'}ms\n*Recent deploys:*\n${deployLines || '_none in the last hour_'}`,
            },
          },
        ];
        await slack.postMessage({ channel: incident.channel_id, text: '📊 Live context', blocks });
      } catch (err) {
        logger.warn({ err }, 'MCP context card failed');
      }
    }
  });

  // Resolve → stop schedulers, remember the incident, start the postmortem.
  core.onResolved(async (incident) => {
    comms.stop(incident.id);
    costMeter.stop(incident.id);
    await memory.indexIncident(incident).catch((err) => logger.warn({ err }, 'memory index failed'));
    postmortem.scheduleKickoff(incident.id);
    // Drill cleanup: reset elevated mock metrics.
    if (incident.is_drill) await drill.end();
  });

  const ctx: AppContext = {
    config,
    db,
    slack,
    llm,
    mcp,
    rts,
    core,
    signals,
    memory,
    comms,
    costMeter,
    postmortem,
    drill,
    deduper: new EventDeduper(),
    watchChannelIds,
  };

  try {
    const auth = (await web.apiCall('auth.test')) as { user_id?: string };
    ctx.botUserId = auth.user_id;
  } catch (err) {
    logger.warn({ err }, 'auth.test failed; bot self-message filtering degraded');
  }

  registerCommands(app, ctx);
  registerActions(app, ctx);
  registerEvents(app, ctx);

  // Signal engine schedulers: RTS poll + clustering tick (spec §6.1).
  const pollMs = config.signalPollSeconds * 1000;
  setInterval(() => {
    void signals.pollTick().catch((err) => logger.warn({ err }, 'pollTick error'));
    void signals.clusterTick().catch((err) => logger.warn({ err }, 'clusterTick error'));
  }, pollMs).unref?.();

  await app.start();
  logger.info(
    { mode: config.slackMode, watching: [...watchChannelIds], mcp: !!mcp, llm: !!llm },
    `⚡ ${config.appName} ready — reading the room`,
  );
}

main().catch((err) => {
  logger.fatal({ err }, 'boot failed');
  process.exit(1);
});
