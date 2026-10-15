import { useId } from 'react';
import { canvasMediaUrl } from '@/api/canvas';
import type { CanvasImageEditNode, CanvasMediaVersion } from '@/schema/canvas';

export function CanvasImageEditSurface({ node, source, projectId }: {
  node: CanvasImageEditNode; source: CanvasMediaVersion | undefined; projectId: string;
}) {
  const maskId = useId();
  if (!source?.width || !source.height) return null;
  const expanded = node.data.options.mode === 'outpaint' && !node.data.editor_state.native;
  const frame = expanded ? node.data.editor_state.frame : { width: source.width, height: source.height, x: 0, y: 0 };
  return <svg role="img" aria-label={`${node.title} 编辑预览`} viewBox={`0 0 ${frame.width} ${frame.height}`} className="size-full p-3 text-primary">
    <defs><mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width={source.width} height={source.height}>
      {node.data.editor_state.strokes.map((stroke, index) => {
        const first = stroke.points[0];
        const last = stroke.points.at(-1);
        if (!first || !last) return null;
        const color = stroke.tool === 'eraser' ? 'black' : 'white';
        if (stroke.tool !== 'rectangle' && stroke.points.length === 1) {
          return <circle key={index} cx={first.x} cy={first.y} r={stroke.size / 2} fill={color} />;
        }
        return stroke.tool === 'rectangle'
          ? <rect key={index} x={Math.min(first.x, last.x)} y={Math.min(first.y, last.y)} width={Math.abs(last.x - first.x)} height={Math.abs(last.y - first.y)} fill={color} />
          : <polyline key={index} points={stroke.points.map(point => `${point.x},${point.y}`).join(' ')} fill="none" stroke={color} strokeWidth={stroke.size} strokeLinecap="round" strokeLinejoin="round" />;
      })}
    </mask></defs>
    {expanded && <rect width={frame.width} height={frame.height} fill="currentColor" fillOpacity=".15" stroke="currentColor" strokeWidth={Math.max(frame.width, frame.height) / 300} />}
    <g transform={`translate(${frame.x} ${frame.y})`}>
      <image href={canvasMediaUrl(projectId, source.version_id, 640)} width={source.width} height={source.height} />
      {!expanded && <rect width={source.width} height={source.height} fill="currentColor" fillOpacity=".6" mask={`url(#${maskId})`} />}
    </g>
  </svg>;
}
