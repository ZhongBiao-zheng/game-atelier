import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { CanvasMentionReference } from '@/lib/canvasMentions';
import { CanvasPromptInput } from './CanvasPromptInput';

const references: CanvasMentionReference[] = [
  {
    nodeId: 'image-a', versionId: 'version-image-a', kind: 'image', label: '图片1',
    title: '雨夜列车', previewUrl: '/media/image-a',
  },
  {
    nodeId: 'text-a', versionId: 'version-text-a', kind: 'text', label: '文本1',
    title: '旁白', text: '一列火车驶入雨夜',
  },
];

function placeCaretAtEnd(element: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

describe('CanvasPromptInput', () => {
  it('opens a caret menu for @ and inserts a stable node token as an image chip', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <CanvasPromptInput value="" references={references} onChange={onChange} placeholder="描述画面" />,
    );
    const editor = screen.getByRole('combobox', { name: '提示词' });
    editor.focus();
    editor.innerHTML = '<div>@</div>';
    placeCaretAtEnd(editor.firstElementChild as HTMLElement);
    fireEvent.input(editor);

    const menu = screen.getByRole('listbox', { name: '引用已连接内容' });
    expect(menu).toHaveAttribute('data-canvas-mention-menu', 'true');
    expect(editor).toHaveAttribute('aria-expanded', 'true');
    expect(editor).toHaveAttribute('aria-controls', menu.id);
    expect(editor.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: /图片1.*雨夜列车/ }).id,
    );
    expect(screen.getByRole('option', { name: /图片1.*雨夜列车/ })).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('option', { name: /图片1.*雨夜列车/ })).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole('option', { name: /图片1.*雨夜列车/ }));
    expect(onChange).toHaveBeenLastCalledWith('@[node:image-a] ');

    rerender(
      <CanvasPromptInput value="@[node:image-a] " references={references} onChange={onChange} placeholder="描述画面" />,
    );
    const chip = editor.querySelector<HTMLElement>('[data-canvas-mention-id="image-a"]');
    expect(chip).not.toBeNull();
    expect(chip).toHaveAttribute('contenteditable', 'false');
    expect(chip?.querySelector('img')).toHaveAttribute('src', '/media/image-a');
  });

  it('filters the menu and supports ArrowDown plus Enter selection', () => {
    const onChange = vi.fn();
    render(<CanvasPromptInput value="" references={references} onChange={onChange} />);
    const editor = screen.getByRole('combobox', { name: '提示词' });
    editor.focus();
    editor.textContent = '@';
    placeCaretAtEnd(editor);
    fireEvent.input(editor);
    fireEvent.keyDown(editor, { key: 'ArrowDown' });
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('@[node:text-a] ');
  });

  it('relabels stable tokens after connection order changes and marks disconnected tokens missing', () => {
    const { rerender } = render(
      <CanvasPromptInput
        value="用 @[node:image-a]，忽略 @[node:gone]"
        references={references}
        onChange={vi.fn()}
      />,
    );
    const editor = screen.getByRole('combobox', { name: '提示词' });
    editor.focus();
    expect(screen.getByLabelText('引用图片：雨夜列车')).toHaveTextContent('图片1');
    // 断连时 token 由 removeCanvasMentionTokens 直接从 prompt 里剥掉，不再渲染「引用已断开」chip。
    expect(screen.queryByLabelText(/引用已断开/)).not.toBeInTheDocument();

    rerender(
      <CanvasPromptInput
        value="用 @[node:image-a]，忽略 @[node:gone]"
        references={[{ ...references[0], label: '图片2', title: '清晨列车' }]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('引用图片：清晨列车')).toHaveTextContent('图片2');
  });

  it('keeps the current editor value while its controlled echo is focused', () => {
    function Harness() {
      const [value, setValue] = useState('');
      return <CanvasPromptInput value={value} references={references} onChange={setValue} />;
    }
    render(<Harness />);
    const editor = screen.getByRole('combobox', { name: '提示词' });
    editor.focus();
    editor.textContent = '电影感';
    placeCaretAtEnd(editor);
    fireEvent.input(editor);
    expect(editor).toHaveTextContent('电影感');
  });

  it('deletes an adjacent chip atomically and previews media chips', async () => {
    const onChange = vi.fn();
    const onPreviewReference = vi.fn();
    render(
      <CanvasPromptInput
        value="@[node:image-a]"
        references={references}
        onChange={onChange}
        onPreviewReference={onPreviewReference}
      />,
    );
    const editor = screen.getByRole('combobox', { name: '提示词' });
    const chip = screen.getByLabelText('引用图片：雨夜列车');
    fireEvent.click(chip);
    expect(onPreviewReference).toHaveBeenCalledWith(references[0]);

    editor.focus();
    placeCaretAtEnd(editor);
    fireEvent.keyDown(editor, { key: 'Backspace' });
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(''));
    expect(editor.querySelector('[data-canvas-mention-id]')).toBeNull();
  });
});
