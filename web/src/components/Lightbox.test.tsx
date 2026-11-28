import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Lightbox } from './Lightbox';
import * as motion from '@/lib/motion';

afterEach(() => { vi.restoreAllMocks(); });

async function loadPhoto(width = 1600, height = 1000) {
  const image = screen.getByAltText('大图') as HTMLImageElement;
  const viewport = image.closest<HTMLElement>('[data-lightbox-viewport]')!;
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 60, 800, 500));
  vi.spyOn(image, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 60, 800, 500));
  Object.defineProperties(image, { naturalWidth: { value: width }, naturalHeight: { value: height } });
  await act(async () => { fireEvent.load(image); });
  return viewport;
}

it('uses original pixels, preserves the pointer anchor and bounds continuous zoom', async () => {
  render(<Lightbox src="/first.png" onClose={vi.fn()} />);
  const viewport = await loadPhoto();
  const label = screen.getByLabelText('当前缩放');
  expect(label).toHaveTextContent('50%');
  fireEvent.keyDown(window, { key: '1' });
  expect(label).toHaveTextContent('100%');
  fireEvent.wheel(viewport, { clientX: 600, clientY: 310, deltaY: -100 });
  expect(label).toHaveTextContent('112%');
  const transform = (viewport.firstElementChild as HTMLElement).style.transform;
  expect(parseFloat(transform.split('(')[1])).toBeCloseTo(-12);
  fireEvent.wheel(viewport, { deltaY: -1000, ctrlKey: true });
  expect(label).toHaveTextContent('400%');
  fireEvent.wheel(viewport, { deltaY: 1000, ctrlKey: true });
  expect(label).toHaveTextContent('25%');
  fireEvent.doubleClick(viewport);
  expect(label).toHaveTextContent('100%');
  fireEvent.doubleClick(viewport);
  expect(label).toHaveTextContent('50%');
});

it('resets to fit on navigation and leaves editing shortcuts with their input', async () => {
  const next = vi.fn();
  const props = { onClose: vi.fn(), onNext: next, details: <div contentEditable role="textbox" /> };
  const { rerender } = render(<Lightbox src="/a.png" {...props} />);
  await loadPhoto();
  fireEvent.keyDown(window, { key: '+' });
  expect(screen.getByLabelText('当前缩放')).toHaveTextContent('56%');
  const field = screen.getByRole('textbox');
  fireEvent.keyDown(field, { key: '1' });
  fireEvent.keyDown(field, { key: 'ArrowRight' });
  expect(next).not.toHaveBeenCalled();
  expect(screen.getByLabelText('当前缩放')).toHaveTextContent('56%');
  fireEvent.keyDown(window, { key: 'ArrowRight' });
  expect(next).toHaveBeenCalledOnce();
  rerender(<Lightbox src="/b.png" {...props} />);
  await loadPhoto(400, 1000);
  expect(screen.getByRole('button', { name: '实际大小' })).toBeEnabled();
  expect(screen.getByLabelText('当前缩放')).toHaveTextContent('50%');
});

it.each([
  ['visible', new DOMRect(40, 30, 200, 125), false, true],
  ['offscreen', new DOMRect(-300, 0, 100, 100), false, false],
  ['missing', null, false, false],
  ['reduced motion', new DOMRect(40, 30, 200, 125), true, false],
] as const)('chooses the opening and closing transition for %s', async (_, rect, reduced, flying) => {
  vi.spyOn(motion, 'motionAvailable').mockReturnValue(true);
  vi.spyOn(motion, 'prefersReducedMotion').mockReturnValue(reduced);
  const animate = vi.spyOn(motion, 'animate').mockReturnValue({
    stop: vi.fn(), finished: new Promise<void>(() => {}),
  } as unknown as ReturnType<typeof motion.animate>);
  const { unmount } = render(<Lightbox src="/image.png" sourceRect={rect} onClose={vi.fn()} />);
  await loadPhoto();
  const copy = document.body.querySelector(':scope > img[aria-hidden="true"]');
  expect(Boolean(copy)).toBe(flying);
  if (!reduced) {
    expect(animate.mock.calls[0][1]).toEqual(flying
      ? { x: [-60, 0], y: [-30, 0], scaleX: [.25, 1], scaleY: [.25, 1], opacity: [1, 1] }
      : { scale: [.96, 1] });
  }
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  expect(animate).toHaveBeenCalledTimes(reduced ? 0 : 2);
  expect(Boolean(document.body.querySelector(':scope > img[aria-hidden="true"]'))).toBe(flying);
  unmount();
  expect(document.body.querySelector(':scope > img[aria-hidden="true"]')).toBeNull();
});

it('hands the image back to the user when they zoom during the opening flight', async () => {
  vi.spyOn(motion, 'motionAvailable').mockReturnValue(true);
  vi.spyOn(motion, 'prefersReducedMotion').mockReturnValue(false);
  const stop = vi.fn();
  vi.spyOn(motion, 'animate').mockReturnValue({
    stop, finished: new Promise<void>(() => {}),
  } as unknown as ReturnType<typeof motion.animate>);
  render(<Lightbox src="/image.png" sourceRect={new DOMRect(10, 10, 100, 100)} onClose={vi.fn()} />);
  const viewport = await loadPhoto();
  fireEvent.wheel(viewport, { deltaY: -100 });
  expect(stop).toHaveBeenCalledOnce();
  expect(screen.getByAltText('大图').style.visibility).toBe('');
  expect(document.body.querySelector(':scope > img[aria-hidden="true"]')).toBeNull();
  expect(screen.getByLabelText('当前缩放')).toHaveTextContent('56%');
});

it('shrinks a zoomed and clipped image inside its viewport on close', async () => {
  vi.spyOn(motion, 'motionAvailable').mockReturnValue(true);
  vi.spyOn(motion, 'prefersReducedMotion').mockReturnValue(false);
  const animate = vi.spyOn(motion, 'animate').mockReturnValue({
    stop: vi.fn(), finished: new Promise<void>(() => {}),
  } as unknown as ReturnType<typeof motion.animate>);
  render(<Lightbox src="/image.png" sourceRect={new DOMRect(40, 30, 200, 125)} onClose={vi.fn()} />);
  await loadPhoto(410, 250);
  fireEvent.click(screen.getByRole('button', { name: '放大' }));
  fireEvent.click(screen.getByRole('button', { name: '放大' }));
  const image = screen.getByAltText('大图');
  vi.mocked(image.getBoundingClientRect).mockReturnValue(new DOMRect(90, 60, 820, 500));
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  expect(document.body.querySelector(':scope > img[aria-hidden="true"]')).toBeNull();
  expect(animate).toHaveBeenLastCalledWith(image, { scale: [1, .96] }, expect.anything());
});

it('steps through discrete levels and disables the fit toggle when the image already fits', async () => {
  render(<Lightbox src="/small.png" onClose={vi.fn()} />);
  const viewport = await loadPhoto(400, 250);
  const label = screen.getByLabelText('当前缩放');
  expect(label).toHaveTextContent('100%');
  expect(screen.getByRole('button', { name: '实际大小' })).toBeDisabled();
  fireEvent.keyDown(window, { key: '1' });
  expect(screen.getByRole('button', { name: '适配' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '放大' }));
  expect(label).toHaveTextContent('150%');
  expect(screen.getByRole('button', { name: '适配' })).toBeEnabled();
  fireEvent.wheel(viewport, { deltaY: 100 });
  fireEvent.click(screen.getByRole('button', { name: '适配' }));
  expect(label).toHaveTextContent('100%');
  expect(screen.getByRole('button', { name: '实际大小' })).toBeDisabled();
});
