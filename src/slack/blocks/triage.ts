import type { PreIncident } from '../../engine/signals.js';
import { fmtDuration, now } from '../../util/time.js';
import type { Block } from './warroom.js';

export function triageBlocks(pre: PreIncident): Block[] {
  const users = [...new Set(pre.signals.map((s) => s.user_id))];
  const lines: string[] = [`⚠️ *Possible incident brewing* — ${pre.one_line}`];

  if (pre.deploy) {
    const ago = fmtDuration(now() - pre.deploy.deployed_at);
    lines.push(`🚢 Deploy \`${pre.deploy.service} ${pre.deploy.id}\` shipped ${ago} ago (\`${pre.deploy.title}\` by @${pre.deploy.author}).`);
  }
  if (pre.similarLine) lines.push(`🧠 ${pre.similarLine}`);

  const blocks: Block[] = [
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Signals from ${users.map((u) => `<@${u}>`).join(', ')} · suggested ${pre.severity_suggestion} · service \`${pre.service}\``,
        },
      ],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: 'declare_incident',
          style: 'danger',
          text: { type: 'plain_text', text: '🚨 Declare incident', emoji: true },
          value: pre.key,
        },
        {
          type: 'button',
          action_id: 'snooze_signal',
          text: { type: 'plain_text', text: '😴 Snooze 15m', emoji: true },
          value: pre.key,
        },
        {
          type: 'button',
          action_id: 'dismiss_signal',
          text: { type: 'plain_text', text: '✋ Not an incident', emoji: true },
          value: pre.key,
        },
      ],
    },
  ];
  return blocks;
}
