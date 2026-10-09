import { describe, expect, it } from 'vitest';
import type { CanvasAgentMessage } from '@/schema/canvas';
import { buildCanvasAgentTimeline } from './canvasAgentTimeline';

let sequence = 0;
function message(role: CanvasAgentMessage['role'], text: string = role): CanvasAgentMessage {
  sequence += 1;
  return {
    role, title: null, text, reasoning_summary: null, turn_id: null, references: [],
    message_id: `m${sequence}`, sequence, created_at: '2026-10-09T00:00:00Z',
  };
}

function shape(blocks: ReturnType<typeof buildCanvasAgentTimeline>) {
  return blocks.map(block => block.kind === 'process' ? `process:${block.steps}` : block.message.text);
}

describe('buildCanvasAgentTimeline', () => {
  const finished = [
    message('user', '出图'), message('tool', '读画布'), message('assistant', '我先建节点'),
    message('tool', '生成'), message('error', '失败一次'), message('assistant', '完成了'),
  ];

  it('collapses the process of a finished turn but keeps errors and the final reply', () => {
    expect(shape(buildCanvasAgentTimeline(finished, false)))
      .toEqual(['出图', 'process:2', '失败一次', '完成了']);
  });

  it('keeps the live last turn expanded while older turns collapse', () => {
    const live = [...finished, message('user', '再来'), message('tool', '读画布')];
    expect(shape(buildCanvasAgentTimeline(live, true)))
      .toEqual(['出图', 'process:2', '失败一次', '完成了', '再来', '读画布']);
  });

  it('leaves turns without tool steps as plain messages', () => {
    const chat = [message('user', '你好'), message('assistant', '你好呀')];
    expect(shape(buildCanvasAgentTimeline(chat, false))).toEqual(['你好', '你好呀']);
  });
});
