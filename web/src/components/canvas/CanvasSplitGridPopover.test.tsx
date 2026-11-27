import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { Popover, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { CanvasSplitGridPopover } from './CanvasSplitGridPopover';

function setup(width = 256, height = 192) {
  const submit = vi.fn(), custom = vi.fn();
  function Fixture() {
    const [open, setOpen] = useState(true);
    return <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild><Button>切分</Button></PopoverTrigger>
      <CanvasSplitGridPopover width={width} height={height} onReturnFocus={() => {}}
        onSubmit={op => { submit(op); setOpen(false); }}
        onCustom={() => { custom(); setOpen(false); }} />
    </Popover>;
  }
  render(<Fixture />);
  return { submit, custom };
}

const button = (name: string) => screen.getByRole('button', { name });

it('previews a rectangle on hover and submits the four-column, three-row preset', () => {
  const { submit } = setup();
  fireEvent.pointerEnter(button('3 列 2 行'));
  expect(screen.getByText('3 × 2')).toBeVisible();
  expect(document.querySelectorAll('[data-active=true]')).toHaveLength(6);
  fireEvent.pointerEnter(button('4×3'));
  expect(document.querySelectorAll('[data-active=true]')).toHaveLength(12);
  fireEvent.click(button('4×3'));
  expect(submit).toHaveBeenCalledWith({ kind: 'split', horizontal_lines: [1 / 3, 2 / 3], vertical_lines: [.25, .5, .75] });
  expect(screen.queryByRole('dialog')).toBeNull();
});

it.each(['{Enter}', ' '])('selects cells with arrows and confirms with %s', async key => {
  const { submit } = setup();
  button('1 列 1 行').focus();
  await userEvent.keyboard('{ArrowRight}{ArrowDown}{ArrowDown}'+key);
  expect(submit).toHaveBeenCalledWith({ kind: 'split', horizontal_lines: [1 / 3, 2 / 3], vertical_lines: [.5] });
});

it('blocks 1×1 and pieces below 16 pixels, accepts the 16-pixel boundary', () => {
  const { submit } = setup(32, 31);
  fireEvent.click(button('1 列 1 行'));
  fireEvent.click(button('2×2'));
  expect(screen.getByText(/每格至少需要/)).toBeVisible();
  expect(submit).not.toHaveBeenCalled();
  fireEvent.click(button('2 列 1 行'));
  expect(submit).toHaveBeenCalledOnce();
});

it('dismisses with Escape and switches to custom lines', async () => {
  const { custom, submit } = setup();
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
  await userEvent.click(button('切分'));
  await userEvent.click(button('自定义切线…'));
  expect(custom).toHaveBeenCalledOnce();
  expect(submit).not.toHaveBeenCalled();
});
