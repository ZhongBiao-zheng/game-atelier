import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GatewayMemberName } from './GatewayMemberName';

afterEach(() => vi.restoreAllMocks());
function setup(onSave = vi.fn().mockResolvedValue(true)) {
  render(<GatewayMemberName name="小王" disabled={false} onSave={onSave} />);
  fireEvent.click(screen.getByRole('button', { name: '重命名 小王' }));
  return { input: screen.getByRole('textbox'), onSave };
}
describe('member inline rename', () => {
  it('trims and saves on Enter once, even when blur follows', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { input, onSave } = setup();
    expect(input).toHaveAttribute('maxLength', '40');
    fireEvent.change(input, { target: { value: ' 小李 ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith('小李');
  });
  it.each(['', '   ', '小王'])('restores without saving blank/unchanged input %j', value => {
    const { input, onSave } = setup();
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '重命名 小王' })).toBeInTheDocument();
  });
  it('Escape cancels without a blur save', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { input, onSave } = setup();
    fireEvent.change(input, { target: { value: '取消' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.blur(input);
    expect(onSave).not.toHaveBeenCalled();
  });
  it('switching applications preserves the draft; clicking elsewhere saves', async () => {
    const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const { input, onSave } = setup();
    fireEvent.change(input, { target: { value: '新名字' } });
    fireEvent.blur(input);
    expect(onSave).not.toHaveBeenCalled();
    expect(input).toHaveValue('新名字');
    focused.mockReturnValue(true);
    fireEvent.blur(input);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('新名字'));
  });
  it('does not submit during IME composition', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { input, onSave } = setup();
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: '小李' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.blur(input);
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith('小李');
  });
  it('keeps draft editable after a failed save', async () => {
    const { input, onSave } = setup(vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true));
    fireEvent.change(input, { target: { value: '保留' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(input).toHaveValue('保留');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
  });
});
