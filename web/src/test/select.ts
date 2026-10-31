import { fireEvent, screen } from '@testing-library/react';

/** 打开 components/ui/select 的下拉（Radix Select 在 jsdom 里靠键盘打开最稳）。 */
export function openSelect(trigger: HTMLElement) {
  fireEvent.keyDown(trigger, { key: 'Enter' });
}

/** 打开下拉并点选一项。 */
export async function chooseOption(trigger: HTMLElement, name: string | RegExp) {
  openSelect(trigger);
  fireEvent.click(await screen.findByRole('option', { name }));
}
