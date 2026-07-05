import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const boolStr = z
  .string()
  .transform((v) => ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()));

const envSchema = z.object({
  SLACK_BOT_TOKEN: z.string().default(''),
  SLACK_APP_TOKEN: z.string().default(''),
  SLACK_SIGNING_SECRET: z.string().default(''),
  SLACK_MODE: z.enum(['socket', 'http']).default('socket'),
  ANTHROPIC_API_KEY: z.string().default(''),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-6'),
  DB_PATH: z.string().default('./data/sentinel.db'),
  WATCH_CHANNELS: z.string().default('eng-general,deploys,support-escalations'),
  SIGNAL_POLL_SECONDS: z.coerce.number().default(45),
  SIGNAL_WINDOW_MINUTES: z.coerce.number().default(12),
  SIGNAL_THRESHOLD: z.coerce.number().default(0.72),
  UPDATE_CADENCE_MINUTES: z.coerce.number().default(15),
  COST_RATE_DEFAULT_PER_MIN: z.coerce.number().default(180),
  MOCK_MCP: boolStr.default('true'),
  APP_NAME: z.string().default('Sentinel IC'),
  STAKEHOLDER_CHANNEL: z.string().default('stakeholders'),
  DEMO_CHANNEL: z.string().default('eng-general'),
  POSTMORTEM_DELAY_SECONDS: z.coerce.number().default(120),
  POSTMORTEM_TIMEOUT_SECONDS: z.coerce.number().default(300),
  HTTP_PORT: z.coerce.number().default(3000),
});

const env = envSchema.parse(process.env);

export interface Config {
  slackBotToken: string;
  slackAppToken: string;
  slackSigningSecret: string;
  slackMode: 'socket' | 'http';
  anthropicApiKey: string;
  anthropicModel: string;
  dbPath: string;
  watchChannels: string[];
  signalPollSeconds: number;
  signalWindowMinutes: number;
  signalThreshold: number;
  updateCadenceMinutes: number;
  costRateDefaultPerMin: number;
  mockMcp: boolean;
  appName: string;
  stakeholderChannel: string;
  demoChannel: string;
  postmortemDelaySeconds: number;
  postmortemTimeoutSeconds: number;
  httpPort: number;
}

export const config: Config = {
  slackBotToken: env.SLACK_BOT_TOKEN,
  slackAppToken: env.SLACK_APP_TOKEN,
  slackSigningSecret: env.SLACK_SIGNING_SECRET,
  slackMode: env.SLACK_MODE,
  anthropicApiKey: env.ANTHROPIC_API_KEY,
  anthropicModel: env.ANTHROPIC_MODEL,
  dbPath: env.DB_PATH,
  watchChannels: env.WATCH_CHANNELS.split(',').map((c) => c.trim().replace(/^#/, '')).filter(Boolean),
  signalPollSeconds: env.SIGNAL_POLL_SECONDS,
  signalWindowMinutes: env.SIGNAL_WINDOW_MINUTES,
  signalThreshold: env.SIGNAL_THRESHOLD,
  updateCadenceMinutes: env.UPDATE_CADENCE_MINUTES,
  costRateDefaultPerMin: env.COST_RATE_DEFAULT_PER_MIN,
  mockMcp: env.MOCK_MCP,
  appName: env.APP_NAME,
  stakeholderChannel: env.STAKEHOLDER_CHANNEL.replace(/^#/, ''),
  demoChannel: env.DEMO_CHANNEL.replace(/^#/, ''),
  postmortemDelaySeconds: env.POSTMORTEM_DELAY_SECONDS,
  postmortemTimeoutSeconds: env.POSTMORTEM_TIMEOUT_SECONDS,
  httpPort: env.HTTP_PORT,
};
