import type { CanvasAgentMessage } from '@/schema/canvas';

/** 刚发出、服务端还没收下的那条用户消息的 id 前缀：先在对话里显示成「发送中」，收下后换成服务端的那条，失败就撤掉。 */
export const OUTGOING_MESSAGE_PREFIX = 'outgoing:';

export function isOutgoingMessage(message: Pick<CanvasAgentMessage, 'message_id'>): boolean {
  return message.message_id.startsWith(OUTGOING_MESSAGE_PREFIX);
}

/** 对话时间线：已结束的一轮里，中间过程（工具步骤、过程中的说明）收成一组，最终回复、报错与提示照常显示。 */
export type CanvasAgentTimelineBlock =
  | { kind: 'message'; message: CanvasAgentMessage }
  | { kind: 'process'; id: string; messages: CanvasAgentMessage[]; steps: number };

/**
 * live：最后一轮还在进行（运行中 / 等确认）——这一轮不收起，过程边做边看。
 * 一轮 = 一条用户消息到下一条用户消息之间；最终回复 = 这一轮最后一条且是 assistant 的消息。
 */
export function buildCanvasAgentTimeline(
  messages: CanvasAgentMessage[],
  live: boolean,
): CanvasAgentTimelineBlock[] {
  const turns: CanvasAgentMessage[][] = [];
  for (const message of messages) {
    if (message.role === 'user' || turns.length === 0) turns.push([message]);
    else turns[turns.length - 1].push(message);
  }
  const blocks: CanvasAgentTimelineBlock[] = [];
  turns.forEach((turn, index) => {
    const [head, ...rest] = turn;
    const isUserTurn = head.role === 'user';
    const body = isUserTurn ? rest : turn;
    if (isUserTurn) blocks.push({ kind: 'message', message: head });
    const collapsible = !(live && index === turns.length - 1);
    const last = body[body.length - 1];
    const final = last?.role === 'assistant' ? last : null;
    // 报错与系统提示（如「模型没有补充说明」）不收进过程组。
    const shown = (message: CanvasAgentMessage) => message.role === 'error' || message.role === 'system';
    const process = body.filter(message => message !== final && !shown(message));
    const steps = process.filter(message => message.role === 'tool').length;
    if (!collapsible || steps === 0) {
      body.forEach(message => blocks.push({ kind: 'message', message }));
      return;
    }
    blocks.push({ kind: 'process', id: process[0].message_id, messages: process, steps });
    body.filter(shown).forEach(message => blocks.push({ kind: 'message', message }));
    if (final) blocks.push({ kind: 'message', message: final });
  });
  return blocks;
}
