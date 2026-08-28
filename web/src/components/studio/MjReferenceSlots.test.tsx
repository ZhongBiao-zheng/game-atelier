import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { EMPTY_MJ_REFS, MjReferenceSlots, routeReusedImageFiles } from './MjReferenceSlots';

beforeAll(() => {
  (URL as any).createObjectURL ??= (file: File) => `blob:${file.name}`;
  (URL as any).revokeObjectURL ??= () => {};
});

function inputFor(label: string): HTMLInputElement {
  const target = screen.getByLabelText(label);
  return document.getElementById(target.getAttribute('for')!) as HTMLInputElement;
}

describe('MjReferenceSlots', () => {
  it('填写 sref 编号时灰掉上传槽，清空后保留已选图并恢复交互', () => {
    const style = new File(['style'], 'style.png', { type: 'image/png' });
    const { rerender } = render(
      <MjReferenceSlots
        refs={{ ...EMPTY_MJ_REFS, sref: [style] }}
        onChange={() => {}}
        version="8.2"
        srefCodeActive
      />,
    );

    const disabledGroup = screen.getByLabelText('风格参考，共 1 张');
    expect(disabledGroup).toHaveClass('opacity-40');
    expect(screen.getByRole('button', { name: '查看风格参考图' })).toBeDisabled();

    rerender(
      <MjReferenceSlots
        refs={{ ...EMPTY_MJ_REFS, sref: [style] }}
        onChange={() => {}}
        version="8.2"
        srefCodeActive={false}
      />,
    );
    expect(screen.getByLabelText('风格参考，共 1 张')).not.toHaveClass('opacity-40');
    expect(screen.getByRole('button', { name: '查看风格参考图' })).toBeEnabled();
  });

  it('同一语义槽一次接收多张图片，并保留已有图片', () => {
    const first = new File(['a'], 'a.png', { type: 'image/png' });
    const second = new File(['b'], 'b.png', { type: 'image/png' });
    const onChange = vi.fn();
    render(
      <MjReferenceSlots
        refs={{ ...EMPTY_MJ_REFS, sref: [first] }}
        onChange={onChange}
        version="8.2"
      />,
    );

    fireEvent.change(inputFor('添加风格参考图'), { target: { files: [second] } });
    expect(onChange).toHaveBeenCalledWith({
      ...EMPTY_MJ_REFS,
      sref: [first, second],
    });
  });

  it('有多张图片时渲染组内全部缩略图与数量', () => {
    const files = ['a', 'b', 'c'].map((name) => new File([name], `${name}.png`, { type: 'image/png' }));
    render(
      <MjReferenceSlots
        refs={{ ...EMPTY_MJ_REFS, image: files }}
        onChange={() => {}}
        version="8.2"
      />,
    );

    expect(screen.getByLabelText('图片参考，共 3 张')).toBeInTheDocument();
    expect(screen.getAllByAltText(/图片参考/)).toHaveLength(4); // 收起封面 1 + 展开面板 3
  });

  it('每个语义槽最多保留四张图片', () => {
    const files = ['a', 'b', 'c', 'd', 'e'].map((name) => (
      new File([name], `${name}.png`, { type: 'image/png' })
    ));
    const onChange = vi.fn();
    render(<MjReferenceSlots refs={EMPTY_MJ_REFS} onChange={onChange} version="8.2" />);

    fireEvent.change(inputFor('上传垫图'), { target: { files } });
    expect(onChange.mock.calls[0][0].image).toHaveLength(4);
    expect(screen.getByRole('status')).toHaveTextContent('每个参考槽最多 4 张');
  });

  it('当前模型非 MJ 时，把历史 MJ 语义参考合并进普通图片槽', () => {
    const image = new File(['image'], 'image.png');
    const style = new File(['style'], 'style.png');
    const routed = routeReusedImageFiles(
      'gpt-image-2', 'mj_fast_imagine', { ...EMPTY_MJ_REFS, image: [image], sref: [style] },
    );

    expect(routed.referenceImages).toEqual([image, style]);
    expect(routed.mjRefs).toEqual(EMPTY_MJ_REFS);
    expect(routed.droppedCount).toBe(0);
  });

  it('当前模型为 MJ 时，把普通历史参考放进 MJ 垫图槽', () => {
    const image = new File(['image'], 'image.png');
    const routed = routeReusedImageFiles(
      'mj_fast_imagine', 'gpt-image-2', { ...EMPTY_MJ_REFS, image: [image] },
    );

    expect(routed.referenceImages).toEqual([]);
    expect(routed.mjRefs.image).toEqual([image]);
  });

  it('历史复用进入 MJ 槽时逐组裁到四张并报告丢弃数', () => {
    const files = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => new File([name], `${name}.png`));
    const routed = routeReusedImageFiles(
      'mj_fast_imagine', 'mj_fast_imagine',
      { ...EMPTY_MJ_REFS, image: files, sref: files.slice(0, 5) },
    );

    expect(routed.mjRefs.image).toHaveLength(4);
    expect(routed.mjRefs.sref).toHaveLength(4);
    expect(routed.droppedCount).toBe(3);
  });
});
