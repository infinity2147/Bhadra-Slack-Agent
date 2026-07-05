/**
 * Scripted demo driver (spec §11): posts drill trouble messages into the demo
 * channel via a one-off Slack connection. The running Sentinel service picks
 * them up and drives the full arc (triage card → declare → war room → …).
 *
 * Usage: npm run demo -- [redis|deploy|db|payment]
 * Requires the main service to be running (`npm run dev`) in the same workspace.
 */
import boltPkg from '@slack/bolt';
import { config } from '../src/config.js';
import { SCENARIOS, type ScenarioName } from '../src/engine/drill.js';
import { logger } from '../src/util/logger.js';

const { App } = boltPkg;

const scenario = (process.argv[2] ?? 'redis') as ScenarioName;
if (!SCENARIOS[scenario]) {
  logger.error({ scenario, available: Object.keys(SCENARIOS) }, 'unknown scenario');
  process.exit(1);
}

async function main(): Promise<void> {
  const app = new App({ token: config.slackBotToken, appToken: config.slackAppToken, socketMode: true });
  const client = app.client;

  // Resolve demo channel.
  const list = await client.conversations.list({ types: 'public_channel', limit: 1000 });
  const channel = list.channels?.find((c) => c.name === config.demoChannel)?.id;
  if (!channel) {
    logger.error({ channel: config.demoChannel }, 'demo channel not found — set DEMO_CHANNEL');
    process.exit(1);
  }

  // Easiest reliable path: trigger the running service's drill via slash-command
  // equivalent — post the drill kickoff messages ourselves. The service's Signal
  // Engine watches this channel and will do the rest.
  const s = SCENARIOS[scenario];
  logger.info({ scenario, channel }, '🎭 posting drill messages');
  for (const msg of s.messages) {
    if (msg.delayMs > 0) await new Promise((r) => setTimeout(r, msg.delayMs));
    await client.chat.postMessage({ channel, text: msg.text });
    logger.info({ text: msg.text }, 'posted');
  }
  logger.info('done — watch for the ⚠️ triage card, then click Declare. (Tip: `/incident drill redis` does all of this in one step.)');
  process.exit(0);
}

main().catch((err) => {
  logger.fatal({ err }, 'demo driver failed');
  process.exit(1);
});
