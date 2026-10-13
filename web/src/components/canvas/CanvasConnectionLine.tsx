import {
  getBezierPath, Position, useStore, ViewportPortal,
  type ConnectionLineComponentProps, type InternalNode, type XYPosition,
} from '@xyflow/react';
import type { FlowNode } from './CanvasEditorViews';

type NodeLookup = Map<string, InternalNode<FlowNode>>;

function edgeCenter(node: InternalNode<FlowNode>, side: 'left' | 'right'): XYPosition {
  const width = node.measured.width ?? Number(node.style?.width ?? 0);
  const height = node.measured.height ?? Number(node.style?.height ?? 0);
  const { x, y } = node.internals.positionAbsolute;
  return { x: side === 'right' ? x + width : x, y: y + height / 2 };
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

/** 拖线预览。从分组拖出时每个成员各牵一条线，分组的「+」跟着指针走。 */
export function CanvasConnectionLine({
  fromX, fromY, toX, toY, fromPosition, toPosition, fromNode,
}: ConnectionLineComponentProps<FlowNode>) {
  const nodeLookup = useStore(state => state.nodeLookup) as NodeLookup;
  const domain = 'domain' in fromNode.data ? fromNode.data.domain : null;
  if (domain?.type !== 'group') return <g>{ropes([{ x: fromX, y: fromY }], fromPosition, { x: toX, y: toY }, toPosition)}</g>;
  return <g>
    {ropes(outputOrigins(nodeLookup, [fromNode.id]), Position.Right, { x: toX, y: toY }, Position.Left)}
    <g className="canvas-group-add-ghost" transform={`translate(${toX} ${toY})`}>
      <circle r={16} />
      <path d="M-5 0H5M0 -5V5" />
    </g>
  </g>;
}

/** 松手后「创建并连接」列表开着的这段时间，线继续连到列表的位置。 */
export function CanvasPendingConnection({ sourceIds, handle, to }: {
  sourceIds: string[]; handle: 'source' | 'target'; to: XYPosition;
}) {
  const nodeLookup = useStore(state => state.nodeLookup) as NodeLookup;
  const origins = handle === 'source'
    ? outputOrigins(nodeLookup, sourceIds)
    : sourceIds.flatMap(id => { const node = nodeLookup.get(id); return node ? [edgeCenter(node, 'left')] : []; });
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
