import {
  getBezierPath, Position, useStore, ViewportPortal,
  type ConnectionLineComponentProps, type InternalNode, type XYPosition,
} from '@xyflow/react';
import type { FlowNode } from './CanvasEditorViews';

type NodeLookup = Map<string, InternalNode<FlowNode>>;

function edgeCenter(node: InternalNode<FlowNode>, side: 'left' | 'right', fraction = 0.5): XYPosition {
  const width = node.measured.width ?? Number(node.style?.width ?? 0);
  const height = node.measured.height ?? Number(node.style?.height ?? 0);
  const { x, y } = node.internals.positionAbsolute;
  return { x: side === 'right' ? x + width : x, y: y + height * fraction };
}

/** 分组整包供参考，进去的是成员的内容，所以线从每个成员出发；其余节点从自己出发。 */
function outputOrigins(nodeLookup: NodeLookup, sourceIds: string[]): XYPosition[] {
  return sourceIds.flatMap(id => {
    const node = nodeLookup.get(id);
    if (!node) return [];
    const domain = 'domain' in node.data ? node.data.domain : null;
    if (domain?.type !== 'group') return [edgeCenter(node, 'right')];
    return domain.data.member_node_ids.flatMap(memberId => {
      const member = nodeLookup.get(memberId);
      return member ? [edgeCenter(member, 'right')] : [];
    });
  });
}

function ropes(origins: XYPosition[], from: Position, to: XYPosition, toPosition: Position) {
  return origins.map((origin, index) => <path key={index} fill="none" className="react-flow__connection-path"
    d={getBezierPath({
      sourceX: origin.x, sourceY: origin.y, sourcePosition: from,
      targetX: to.x, targetY: to.y, targetPosition: toPosition,
    })[0]} />);
}

/** 拖线预览。从分组拖出时每个成员各牵一条线，带加号的把手随指针移动，对比槽沿用圆点。 */
export function CanvasConnectionLine({
  fromX, fromY, toX, toY, fromPosition, toPosition, fromNode, fromHandle,
}: ConnectionLineComponentProps<FlowNode>) {
  const nodeLookup = useStore(state => state.nodeLookup) as NodeLookup;
  const zoom = useStore(state => state.transform[2]);
  const compareSlot = fromHandle.id === 'before' || fromHandle.id === 'after';
  const domain = 'domain' in fromNode.data ? fromNode.data.domain : null;
  const origins = domain?.type === 'group' ? outputOrigins(nodeLookup, [fromNode.id]) : [{ x: fromX, y: fromY }];
  return <g>
    {ropes(origins, fromPosition, { x: toX, y: toY }, toPosition)}
    {compareSlot ? <circle cx={toX} cy={toY} r={4} className="fill-primary" /> :
      <g className="canvas-handle-add-ghost" transform={`translate(${toX} ${toY}) scale(${1 / zoom})`}>
        <circle r={13} />
        <path d="M-4.5 0H4.5M0 -4.5V4.5" />
      </g>}
  </g>;
}

/** 松手后「创建并连接」列表开着的这段时间，线继续连到列表的位置。 */
export function CanvasPendingConnection({ sourceIds, handle, slot, to }: {
  sourceIds: string[]; handle: 'source' | 'target'; slot?: 'before' | 'after'; to: XYPosition;
}) {
  const nodeLookup = useStore(state => state.nodeLookup) as NodeLookup;
  const origins = handle === 'source'
    ? outputOrigins(nodeLookup, sourceIds)
    : sourceIds.flatMap(id => { const node = nodeLookup.get(id); return node ? [edgeCenter(node, 'left', slot === 'before' ? 0.35 : slot === 'after' ? 0.65 : 0.5)] : []; });
  return <ViewportPortal>
    <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width="1" height="1" aria-hidden="true">
      <g className="react-flow__connection">
        {handle === 'source'
          ? ropes(origins, Position.Right, to, Position.Left)
          : ropes(origins, Position.Left, to, Position.Right)}
      </g>
    </svg>
  </ViewportPortal>;
}
