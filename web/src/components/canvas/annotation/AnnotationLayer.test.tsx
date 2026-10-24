import { render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { AnnotationLayer } from './AnnotationLayer';
import type { AnnotationElement } from './annotationModel';
it('renders the shared SVG with scaled outlines and optional text background', () => {
  const elements: AnnotationElement[] = [
    { id: 'r', type: 'rect', color: '#F04438', x: 0, y: 0, width: 10, height: 10, stroke_width: 4 },
    { id: 'a', type: 'arrow', color: '#F04438', start: [0, 0], end: [100, 100], stroke_width: 4 },
    { id: 'p', type: 'freedraw', color: '#F04438', points: [[0, 0], [10, 10], [20, 10]], stroke_width: 4 },
    { id: 't', type: 'text', color: '#FACC15', x: 10, y: 10, text: '帽子\n改红', font_size: 18, background: false },
  ];
  const view = render(<AnnotationLayer elements={elements} imageWidth={2048} imageHeight={1024} />);
  expect(view.container.querySelector('svg')).toHaveAttribute('preserveAspectRatio', 'xMidYMid meet');
  expect(view.container.querySelector('rect')).toHaveAttribute('stroke-width', '8');
  expect(view.container.querySelectorAll('path')).toHaveLength(2);
  expect(view.container.querySelector('text')).toHaveAttribute('paint-order', 'stroke');
  expect(view.container.querySelectorAll('tspan')).toHaveLength(2);
  elements[3] = { ...elements[3], background: true } as AnnotationElement;
  view.rerender(<AnnotationLayer elements={elements} imageWidth={2048} imageHeight={1024} fit="cover" />);
  expect(view.container.querySelector('svg')).toHaveAttribute('preserveAspectRatio', 'xMidYMid slice');
  expect(view.container.querySelectorAll('rect')).toHaveLength(2);
  expect(view.container.querySelector('text')).toHaveAttribute('stroke', 'none');
  expect(view.container.querySelector('foreignObject')).toBeNull();
});
