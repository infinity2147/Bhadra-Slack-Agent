import type { Incident } from '../../db/index.js';
import { fmtDuration, fmtUsd } from '../../util/time.js';
import type { Block } from './warroom.js';

const SPARK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/** Text sparkline of MTTR (minutes), oldest → newest. */
export function mttrSparkline(durationsMin: number[]): string {
  if (durationsMin.length === 0) return '—';
  const max = Math.max(...durationsMin, 1);
  return durationsMin.map((d) => SPARK_CHARS[Math.min(7, Math.floor((d / max) * 7))]).join('');
}

export function homeBlocks(data: {
  active: Incident[];
  recent: Incident[];
  appName: string;
}): Block[] {
  const { active, recent, appName } = data;
  const blocks: Block[] = [
    { type: 'header', text: { type: 'plain_text', text: `🛡️ ${appName}`, emoji: true } },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: 'Reads the room · runs the war room · writes the postmortem' }],
    },
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: `*🚨 Active incidents (${active.length})*` } },
  ];

  if (active.length === 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '_All quiet. Sentinel is watching your channels._' } });
  }
  for (const inc of active) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${inc.id}* — ${inc.title}\n${inc.severity ?? 'SEV?'} · ${inc.status} · 💸 ${fmtUsd(inc.cost_estimate_usd)}${inc.is_drill ? ' · 🎭 DRILL' : ''}${inc.channel_id ? ` · <#${inc.channel_id}>` : ''}`,
      },
    });
  }

  blocks.push({ type: 'divider' }, { type: 'section', text: { type: 'mrkdwn', text: `*✅ Recently resolved*` } });
  if (recent.length === 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '_No resolved incidents yet._' } });
  }
  for (const inc of recent.slice(0, 5)) {
    const dur = inc.resolved_at ? fmtDuration(inc.resolved_at - inc.started_at) : '—';
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${inc.id}* — ${inc.title}\n⏱️ ${dur} · 💸 ${fmtUsd(inc.cost_estimate_usd)}${inc.is_drill ? ' · 🎭' : ''}`,
      },
    });
  }

  const durations = recent
    .filter((i) => i.resolved_at)
    .map((i) => Math.round((i.resolved_at! - i.started_at) / 60))
    .reverse();
  blocks.push(
    { type: 'divider' },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `*MTTR trend:* ${mttrSparkline(durations)} ${durations.length ? `(latest ${durations[durations.length - 1]}m)` : ''}`,
        },
      ],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: 'home_declare',
          style: 'danger',
          text: { type: 'plain_text', text: '🚨 Declare incident', emoji: true },
        },
        {
          type: 'button',
          action_id: 'start_drill',
          text: { type: 'plain_text', text: '🎭 Run a drill', emoji: true },
          value: 'redis',
        },
        {
          type: 'button',
          action_id: 'home_config',
          text: { type: 'plain_text', text: '⚙️ Config', emoji: true },
        },
      ],
    },
  );
  return blocks;
}
