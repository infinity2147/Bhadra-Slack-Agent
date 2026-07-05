/** Modal + App Home view builders. */
import type { Block } from './blocks/warroom.js';

export const DECLARE_MODAL_CALLBACK = 'declare_modal';

export function declareModalView(prefill: { title?: string; preKey?: string } = {}): Record<string, unknown> {
  return {
    type: 'modal',
    callback_id: DECLARE_MODAL_CALLBACK,
    private_metadata: prefill.preKey ?? '',
    title: { type: 'plain_text', text: '🚨 Declare incident', emoji: true },
    submit: { type: 'plain_text', text: 'Declare' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'title_block',
        label: { type: 'plain_text', text: 'Title' },
        element: {
          type: 'plain_text_input',
          action_id: 'title',
          initial_value: prefill.title ?? '',
          placeholder: { type: 'plain_text', text: 'e.g. Checkout latency spike' },
        },
      },
      {
        type: 'input',
        block_id: 'service_block',
        optional: true,
        label: { type: 'plain_text', text: 'Service' },
        element: {
          type: 'plain_text_input',
          action_id: 'service',
          placeholder: { type: 'plain_text', text: 'e.g. checkout' },
        },
      },
      {
        type: 'input',
        block_id: 'severity_block',
        optional: true,
        label: { type: 'plain_text', text: 'Severity' },
        element: {
          type: 'static_select',
          action_id: 'severity',
          initial_option: { text: { type: 'plain_text', text: 'SEV2' }, value: 'SEV2' },
          options: ['SEV1', 'SEV2', 'SEV3', 'SEV4'].map((s) => ({
            text: { type: 'plain_text', text: s },
            value: s,
          })),
        },
      },
    ] satisfies Block[],
  };
}

export function configInfoView(lines: string[]): Record<string, unknown> {
  return {
    type: 'modal',
    title: { type: 'plain_text', text: '⚙️ Sentinel config', emoji: true },
    close: { type: 'plain_text', text: 'Done' },
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: 'Change via `/incident config cost <service> <usd_per_min>` and `/incident config watch <#channel>`.',
          },
        ],
      },
    ],
  };
}
