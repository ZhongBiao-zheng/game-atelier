type HorizontalRect = {
  left: number;
  right: number;
};

export function canvasNodePanelWidth(
  viewportWidth: number,
  preferredWidth = 608,
  margin = 16,
) {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= margin * 2) return preferredWidth;
  return Math.min(preferredWidth, viewportWidth - margin * 2);
}

export function canvasNodePanelOffsetX(
  rect: HorizontalRect,
  viewportWidth: number,
  zoom: number,
  margin = 16,
) {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const minScreenOffset = margin - rect.left;
  const maxScreenOffset = viewportWidth - margin - rect.right;
  let screenOffset = 0;
  if (minScreenOffset <= maxScreenOffset) {
    screenOffset = Math.min(maxScreenOffset, Math.max(minScreenOffset, 0));
  } else {
    screenOffset = minScreenOffset;
  }
  return screenOffset / safeZoom;
}
