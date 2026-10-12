import { getBezierPath, Position, useStore, type ConnectionLineComponentProps } from '@xyflow/react';
import type { FlowNode } from './CanvasEditorViews';

/** 拖线预览。从分组拖出时，每个成员各牵一条线到指针：分组整包供参考，进去的是成员的内容。 */
export function CanvasConnectionLine({
  fromX, fromY, toX, toY, fromPosition, toPosition, fromNode,
}: ConnectionLineComponentProps<FlowNode>) {
  const nodeLookup = useStore(state => state.nodeLookup);
  const domain = 'domain' in fromNode.data ? fromNode.data.domain : null;
  const members = domain?.type === 'group' ? domain.data.member_node_ids.flatMap(id => {
    const member = nodeLookup.get(id);
    if (!member) return [];
    const width = member.measured.width ?? Number(member.style?.width ?? 0);
    const height = member.measured.height ?? Number(member.style?.height ?? 0);
    const { x, y } = member.internals.positionAbsolute;
    return [{ x: x + width, y: y + height / 2 }];
  }) : [];
  const origins = members.length ? members : [{ x: fromX, y: fromY }];
  return <g>
    {origins.map((origin, index) => <path key={index} fill="none" className="react-flow__connection-path"
      d={getBezierPath({
        sourceX: origin.x, sourceY: origin.y, sourcePosition: members.length ? Position.Right : fromPosition,
        targetX: toX, targetY: toY, targetPosition: toPosition,
      })[0]} />)}
  </g>;
}
