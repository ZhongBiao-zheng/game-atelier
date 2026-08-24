import { expect, it } from 'vitest';

import { canvasNodePanelOffsetX, canvasNodePanelWidth } from './canvasNodePanelPlacement';

it('keeps the preferred panel width at ordinary zoom', () => {
  expect(canvasNodePanelWidth(1440, 1)).toBe(608);
});

it('shrinks the canvas-space width at high zoom to preserve screen margins', () => {
  expect(canvasNodePanelWidth(1440, 2.5)).toBeCloseTo(563.2);
});

it('keeps a centered node panel in place when it fits the viewport', () => {
  expect(canvasNodePanelOffsetX({ left: 200, right: 800 }, 1000, 1)).toBe(0);
});

it('clamps a node panel to the left viewport safety margin', () => {
  expect(canvasNodePanelOffsetX({ left: -34, right: 566 }, 1000, 1)).toBe(50);
});

it('clamps a node panel to the right viewport safety margin', () => {
  expect(canvasNodePanelOffsetX({ left: 534, right: 1134 }, 1000, 1)).toBe(-150);
});

it('converts the screen-space correction into canvas coordinates at zoom', () => {
  expect(canvasNodePanelOffsetX({ left: -34, right: 866 }, 1200, 2)).toBe(25);
});
