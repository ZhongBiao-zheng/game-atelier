import type { SVGProps } from 'react';
import { annotationUnitScale, ANNOTATION_COLORS, ANNOTATION_DARK, ANNOTATION_FONT, ANNOTATION_INK, ANNOTATION_SELECTION,
  ANNOTATION_WHITE, elementBounds, penPath, textBounds, type AnnotationElement } from './annotationModel';

export interface AnnotationLayerProps extends SVGProps<SVGSVGElement> {
  elements: AnnotationElement[];
  imageWidth: number;
  imageHeight: number;
  fit?: 'contain' | 'cover' | 'fill';
  selectedId?: string | null;
  screenPixel?: number;
}
export function AnnotationLayer({ elements, imageWidth, imageHeight, fit = 'contain', selectedId,
  screenPixel = 1, ...props }: AnnotationLayerProps) {
  const unit = annotationUnitScale(imageWidth, imageHeight);
  const selected = elements.find(element => element.id === selectedId);
  const box = selected && elementBounds(selected, unit);
  const pad = screenPixel * 4;
  return <svg xmlns="http://www.w3.org/2000/svg" width={imageWidth} height={imageHeight}
    viewBox={`0 0 ${imageWidth} ${imageHeight}`} preserveAspectRatio={fit === 'fill' ? 'none' : `xMidYMid ${fit === 'cover' ? 'slice' : 'meet'}`}
    {...props}>
    {elements.map(element => {
      if (element.type === 'rect') return <rect key={element.id} x={element.x} y={element.y} width={element.width} height={element.height}
        rx={unit} fill="none" stroke={element.color} strokeWidth={element.stroke_width * unit} strokeLinejoin="round" />;
      if (element.type === 'arrow') {
        const [x, y] = element.end;
        const angle = Math.atan2(y - element.start[1], x - element.start[0]);
        const length = Math.max(12, 3.5 * element.stroke_width) * unit;
        const wing = (sign: number) => `${x - length * Math.cos(angle + sign * 28 * Math.PI / 180)} ${y - length * Math.sin(angle + sign * 28 * Math.PI / 180)}`;
        return <path key={element.id} d={`M ${element.start.join(' ')} L ${x} ${y} M ${wing(1)} L ${x} ${y} L ${wing(-1)}`}
          fill="none" stroke={element.color} strokeWidth={element.stroke_width * unit} strokeLinecap="round" strokeLinejoin="round" />;
      }
      if (element.type === 'freedraw') return <path key={element.id} d={penPath(element.points)} fill="none"
        stroke={element.color} strokeWidth={element.stroke_width * unit} strokeLinecap="round" strokeLinejoin="round" />;
      const font = element.font_size * unit, bounds = textBounds(element, unit);
      const x = element.x + (element.background ? font * .5 : 0);
      const y = element.y + (element.background ? font * .25 : 0);
      return <g key={element.id}>
        {element.background && <rect {...bounds} rx={font * .2} fill={element.color} />}
        <text fontFamily={ANNOTATION_FONT} fontSize={font} fontWeight={600}
          fill={element.background ? (element.color === ANNOTATION_WHITE || element.color === ANNOTATION_COLORS[1] ? ANNOTATION_INK : ANNOTATION_WHITE) : element.color}
          paintOrder="stroke" stroke={element.background ? 'none' : ANNOTATION_DARK} strokeOpacity={.85}
          strokeWidth={font * .18} strokeLinejoin="round">
          {element.text.split('\n').map((line, index) => <tspan key={index} x={x} y={y + font * (1 + index * 1.3)}>{line}</tspan>)}
        </text>
      </g>;
    })}
    {box && <g pointerEvents="none" stroke={ANNOTATION_SELECTION} strokeWidth={screenPixel}>
      <rect x={box.x - pad} y={box.y - pad} width={box.width + pad * 2} height={box.height + pad * 2} fill="none" strokeDasharray={`${4 * screenPixel} ${3 * screenPixel}`} />
      {selected?.type === 'text' && [0, 1].flatMap(x => [0, 1].map(y => <rect key={`${x}-${y}`} data-annotation-resize={`${x}-${y}`} pointerEvents="all" style={{ cursor: x === y ? 'nwse-resize' : 'nesw-resize' }} x={box.x - pad + x * (box.width + pad * 2) - pad}
        y={box.y - pad + y * (box.height + pad * 2) - pad} width={8 * screenPixel} height={8 * screenPixel} fill={ANNOTATION_WHITE} />))}
    </g>}
  </svg>;
}
