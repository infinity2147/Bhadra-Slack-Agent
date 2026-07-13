import type { Tenant, TenantReport } from '../../db/index.js';
import type { Block } from './warroom.js';

/** Triage card posted into the routed INTERNAL team channel for a customer report. */
export function tenantReportTriageBlocks(
  report: TenantReport,
  tenant: Tenant,
  summary: string,
  opts: { roster?: { userId: string; role: string }[] } = {},
): Block[] {
  const blocks: Block[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `📨 *Customer report* — *${tenant.name}*${tenant.tier ? ` _(${tenant.tier})_` : ''} · ref \`${report.id}\`\n${summary}`,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Reported by <@${report.reporter_user_id}> · suggested *${report.severity_suggestion}* · category \`${report.category}\``,
        },
      ],
    },
    { type: 'section', text: { type: 'mrkdwn', text: `> ${report.report_text.replace(/\n/g, '\n> ')}` } },
  ];
  if (opts.roster?.length) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Matched roster: ${opts.roster.map((m) => `<@${m.userId}> (${m.role})`).join(', ')}`,
        },
      ],
    });
  }
  blocks.push(
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: 'declare_incident',
          style: 'danger',
          text: { type: 'plain_text', text: '🚨 Declare incident', emoji: true },
          value: report.id,
        },
        {
          type: 'button',
          action_id: 'decline_report',
          text: { type: 'plain_text', text: '✋ Decline', emoji: true },
          value: report.id,
        },
      ],
    },
  );
  return blocks;
}
