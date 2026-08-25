import { expect, it } from 'vitest';

import { canvasNodePanelOffsetX, canvasNodePanelWidth } from './canvasNodePanelPlacement';

it('keeps the preferred panel width at ordinary zoom', () => {
  expect(canvasNodePanelWidth(1440)).toBe(608);
});

it('keeps screen width independent from canvas zoom', () => {
  expect(canvasNodePanelWidth(1440)).toBe(608);
  expect(canvasNodePanelWidth(768)).toBe(608);
});

it('shrinks only when the viewport cannot fit the preferred screen width', () => {
  expect(canvasNodePanelWidth(540)).toBe(508);
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
