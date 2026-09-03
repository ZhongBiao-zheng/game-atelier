import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

import { PromptInput, domToText, renumberMentions, serializeMentions } from './PromptInput';
import type { KeyView } from '@/api/keys';

const hkKey: KeyView = {
  alias: 'hk',
  provider: 'custom',
  base_url: 'https://api.openai-hk.com',
  access_key: 'hk...key',
  secret_key: null,
  capabilities: ['portrait'],
  models: [
    { name: 'GPT Image 2', id: 'gpt-image-2' },
    { name: 'Nano Banana', id: 'nano-banana' },
    { name: 'Nano Banana Pro 4K', id: 'nano-banana-pro-4k' },
  ],
  notes: '',
  created_at: '2026-05-25T00:00:00Z',
};

function renderWith(model: string) {
  return render(
    <PromptInput
      onSubmit={vi.fn()}
      providers={[hkKey]}
      providerAlias="hk"
      model={model}
    />,
  );
}

describe('PromptInput 编辑区', () => {
  it('隐藏原生滚动条并保留纵向滚动', () => {
    renderWith('gpt-image-2');
    const editor = screen.getByRole('textbox', { name: '生图 prompt' });
    expect(editor).toHaveClass('no-scrollbar', 'overflow-y-auto');
    cleanup();
  });
});

describe('PromptInput 尺寸面板按模型族渲染', () => {
  it('gpt-image: 显示自定义尺寸 + 质量，不显示分辨率', () => {
    renderWith('gpt-image-2');
    fireEvent.click(screen.getByRole('button', { name: /选择比例和分辨率/ }));
    expect(screen.getByLabelText('输出宽度')).toBeInTheDocument();
    expect(screen.getByLabelText('选择质量')).toBeInTheDocument();
    expect(screen.queryByLabelText('选择分辨率')).not.toBeInTheDocument();
    cleanup();
  });

  it('nano-banana: 仅显示质量，不显示分辨率/自定义尺寸', () => {
    renderWith('nano-banana');
    fireEvent.click(screen.getByRole('button', { name: /选择比例和分辨率/ }));
    expect(screen.getByLabelText('选择质量')).toBeInTheDocument();
    expect(screen.queryByLabelText('选择分辨率')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('输出宽度')).not.toBeInTheDocument();
    cleanup();
  });

  it('固定 4K nano-banana: 型号已经定档，不再显示质量', () => {
    renderWith('nano-banana-pro-4k');
    const sizeButton = screen.getByRole('button', { name: /选择比例和分辨率/ });
    expect(sizeButton).toHaveTextContent(/^1:1$/);
    expect(sizeButton).not.toHaveTextContent('|');
    fireEvent.click(sizeButton);
    expect(screen.queryByLabelText('选择质量')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('选择分辨率')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('输出宽度')).not.toBeInTheDocument();
    cleanup();
  });
});

// --- video mode ---
import { videoControlCaps } from '@/lib/videoControlCaps';

const videoKey = {
  alias: 'ark', provider: 'volcengine_video', base_url: null, access_key: '***', secret_key: null,
  capabilities: [], models: [{ name: 'Seedance', id: 'doubao-seedance-2-0-fast-260128' }],
  modalities: ['video'], notes: '', created_at: '',
};

function renderVideoMode(overrides = {}) {
  const onModeChange = vi.fn();
  render(
    <PromptInput
      onSubmit={vi.fn()}
      providers={[videoKey as any]}
      providerAlias="ark"
      model="doubao-seedance-2-0-fast-260128"
      kind="video"
      onKindChange={vi.fn()}
      videoMode="firstlast"
      videoCaps={videoControlCaps('doubao-seedance-2-0-fast-260128')}
      duration={5}
      videoResolution="720p"
      videoRatio="16:9"
      generateAudio={false}
      onVideoModeChange={onModeChange}
      onDurationChange={vi.fn()}
      onVideoResolutionChange={vi.fn()}
      onVideoRatioChange={vi.fn()}
      onGenerateAudioChange={vi.fn()}
      referenceVideos={[]}
      referenceAudios={[]}
      onReferenceVideosChange={vi.fn()}
      onReferenceAudiosChange={vi.fn()}
      referenceImages={[]}
      onReferenceImagesChange={vi.fn()}
      videoFrames={{ first: null, last: null }}
      onVideoFramesChange={vi.fn()}
      {...overrides}
    />,
  );
  return { onModeChange };
}

describe('PromptInput video mode', () => {
  it('renders the combined video settings button in video kind', () => {
    renderVideoMode();
    expect(screen.getByLabelText('视频设置')).toBeInTheDocument();
    cleanup();
  });

  it('does not render the image size control in video kind', () => {
    renderVideoMode();
    expect(screen.queryByLabelText('选择比例和分辨率')).not.toBeInTheDocument();
    cleanup();
  });

  it('renders 首尾帧 slots left of the textarea in firstlast mode', () => {
    renderVideoMode({ videoMode: 'firstlast' });
    expect(screen.getByLabelText('上传首帧')).toBeInTheDocument();
    expect(screen.getByLabelText('上传尾帧')).toBeInTheDocument();
    expect(screen.getByLabelText('互换首尾帧')).toBeInTheDocument();
    cleanup();
  });

  it('renders the omni reference stack entry left of the textarea in omni mode', () => {
    renderVideoMode({ videoMode: 'omni' });
    expect(screen.getByLabelText('添加参考内容')).toBeInTheDocument();
    expect(screen.getByTestId('reference-images-panel')).toBeInTheDocument();
    expect(screen.queryByLabelText('上传首帧')).not.toBeInTheDocument();
    cleanup();
  });

  it('kind button opens a popover and selecting 图片生成 emits onKindChange', () => {
    const onKindChange = vi.fn();
    renderVideoMode({ onKindChange });
    fireEvent.click(screen.getByLabelText('选择生成模式'));
    fireEvent.click(screen.getByRole('option', { name: /图片生成/ }));
    expect(onKindChange).toHaveBeenCalledWith('image');
    cleanup();
  });
});

describe('PromptInput 模型按分类过滤（模型级 modality 优先，key 级兜底）', () => {
  const mixedKey: KeyView = {
    ...hkKey,
    alias: 'mixed',
    base_url: 'https://api.example.com',
    models: [
      { name: 'GPT Image 2', id: 'gpt-image-2', modality: 'image' },
      { name: 'Sora 2', id: 'sora-2', modality: 'video' },
    ],
    modalities: ['image', 'video'],
  };

  it('图片模式只列出图片模型', () => {
    render(
      <PromptInput onSubmit={vi.fn()} providers={[mixedKey]} providerAlias="mixed" model="gpt-image-2" />,
    );
    fireEvent.click(screen.getByLabelText('选择模型'));
    expect(screen.getByRole('option', { name: /GPT Image 2/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Sora 2/ })).not.toBeInTheDocument();
    cleanup();
  });

  it('视频模式只列出视频模型，混挂 key 仍可见', () => {
    renderVideoMode({ providers: [mixedKey as any], providerAlias: 'mixed', model: 'sora-2' });
    fireEvent.click(screen.getByLabelText('选择模型'));
    expect(screen.getByRole('option', { name: /Sora 2/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /GPT Image 2/ })).not.toBeInTheDocument();
    cleanup();
  });

  it('未标注模型按 key 级 modalities 兜底（纯 video key 在视频模式可见）', () => {
    renderVideoMode();
    fireEvent.click(screen.getByLabelText('选择模型'));
    expect(screen.getByRole('option', { name: /Seedance/ })).toBeInTheDocument();
    cleanup();
  });
});

describe('PromptInput @引用参考素材', () => {
  beforeAll(() => {
    if (!URL.createObjectURL) (URL as any).createObjectURL = () => 'blob:stub';
    if (!URL.revokeObjectURL) (URL as any).revokeObjectURL = () => {};
  });

  it('renumberMentions：被删序号的引用移除，更大序号前移，其他类目不动', () => {
    expect(renumberMentions('@图1 模仿 @图2，音色参考 @音频1', '图', 1)).toBe(' 模仿 @图1，音色参考 @音频1');
  });

  it('serializeMentions：提交时剥掉 @，序号自然语言保留', () => {
    expect(serializeMentions('@图1 模仿 @视频2 的动作')).toBe('图1 模仿 视频2 的动作');
    expect(serializeMentions('@图片1 保持角色身份')).toBe('图1 保持角色身份');
  });

  /** jsdom 没有真实键入：直接落 '@' 文本节点 + 设光标 + 触发 input，等效敲 @。 */
  function typeAtSign(editor: HTMLElement) {
    const textNode = document.createTextNode('@');
    editor.appendChild(textNode);
    const range = document.createRange();
    range.setStart(textNode, 1);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    fireEvent.input(editor);
  }

  // @引用开放给 omni 全能参考与图片图生图（MJ 除外），见 PromptInput mentionsEnabled 门控。
  it('omni 模式有素材时敲 @ 弹菜单，点选项把 @ 替换成原子 chip 并关闭菜单', () => {
    const onSubmit = vi.fn();
    const file = new File(['x'], 'hero.png', { type: 'image/png' });
    renderVideoMode({ videoMode: 'omni', referenceImages: [file], onSubmit });
    const editor = screen.getByLabelText('生图 prompt');
    typeAtSign(editor);
    expect(screen.getByTestId('mention-popover')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: /图1/ }));
    expect(editor.querySelector('[data-mention="图1"]')).not.toBeNull();
    expect(screen.queryByTestId('mention-popover')).toBeNull();
    // 触发字符 @ 被 chip 吞掉，提交序列化成纯序号
    fireEvent.click(screen.getByLabelText('提交生成'));
    expect(onSubmit).toHaveBeenCalledWith('图1');
    cleanup();
  });

  it('没有素材时敲 @ 不弹菜单', () => {
    render(<PromptInput onSubmit={vi.fn()} providers={[hkKey]} providerAlias="hk" model="gpt-image-2" />);
    typeAtSign(screen.getByLabelText('生图 prompt'));
    expect(screen.queryByTestId('mention-popover')).toBeNull();
    cleanup();
  });

  it('omni 受控 value 里的 @图N 字面量渲染成 chip，提交时序列化为纯序号', () => {
    const onSubmit = vi.fn();
    const file = new File(['x'], 'hero.png', { type: 'image/png' });
    renderVideoMode({
      videoMode: 'omni', referenceImages: [file], onSubmit,
      value: '@图1 在雨中奔跑', onValueChange: vi.fn(),
    });
    const editor = screen.getByLabelText('生图 prompt');
    expect(editor.querySelector('[data-mention="图1"]')).not.toBeNull();
    fireEvent.click(screen.getByLabelText('提交生成'));
    expect(onSubmit).toHaveBeenCalledWith('图1 在雨中奔跑');
    cleanup();
  });

  it('omni hover chip 在上方弹出素材预览，移出关闭', () => {
    const file = new File(['x'], 'hero.png', { type: 'image/png' });
    renderVideoMode({
      videoMode: 'omni', referenceImages: [file],
      value: '@图1 ', onValueChange: vi.fn(),
    });
    const chip = screen.getByLabelText('生图 prompt').querySelector('[data-mention="图1"]')!;
    fireEvent.mouseOver(chip);
    expect(screen.getByTestId('mention-preview')).toBeInTheDocument();
    fireEvent.mouseOut(chip);
    expect(screen.queryByTestId('mention-preview')).toBeNull();
    cleanup();
  });

  it('domToText：chip 还原 @字面量，BR 还原换行', () => {
    const root = document.createElement('div');
    root.appendChild(document.createTextNode('看'));
    const chip = document.createElement('span');
    chip.setAttribute('data-mention', '视频1');
    chip.textContent = '视频1';
    root.appendChild(chip);
    root.appendChild(document.createElement('br'));
    root.appendChild(document.createTextNode('动作'));
    expect(domToText(root)).toBe('看@视频1\n动作');
  });
});

describe('PromptInput 参考素材超限提示', () => {
  beforeAll(() => {
    if (!URL.createObjectURL) (URL as any).createObjectURL = () => 'blob:stub';
    if (!URL.revokeObjectURL) (URL as any).revokeObjectURL = () => {};
  });

  it('超出上限的文件被忽略并给出按类目提示（nano-banana 上限 3）', () => {
    const onChange = vi.fn();
    const { container } = render(
      <PromptInput onSubmit={vi.fn()} providers={[hkKey]} providerAlias="hk" model="nano-banana"
        referenceImages={[]} onReferenceImagesChange={onChange} />,
    );
    const input = container.querySelector('input[type=file]')!;
    const files = [1, 2, 3, 4].map((i) => new File(['x'], `r${i}.png`, { type: 'image/png' }));
    fireEvent.change(input, { target: { files } });
    expect(screen.getByRole('status')).toHaveTextContent('参考图最多 3 张，已忽略 1 个文件');
    expect(onChange).toHaveBeenCalledWith(files.slice(0, 3));
    cleanup();
  });

  // 上限按模型族走：换模型（gpt-image 16 → nano-banana 3）后已在堆叠里的参考图必须当场裁掉，
  // 否则界面上 chip 全在、后端只发前 3 张（静默丢弃）。
  it('切换到上限更低的模型时裁掉超出的参考图并提示', () => {
    const onChange = vi.fn();
    const files = [1, 2, 3, 4, 5].map((i) => new File(['x'], `r${i}.png`, { type: 'image/png' }));
    const { rerender } = render(
      <PromptInput onSubmit={vi.fn()} providers={[hkKey]} providerAlias="hk" model="gpt-image-2"
        referenceImages={files} onReferenceImagesChange={onChange} />,
    );
    expect(onChange).not.toHaveBeenCalled(); // gpt-image 上限 16，5 张不动
    rerender(
      <PromptInput onSubmit={vi.fn()} providers={[hkKey]} providerAlias="hk" model="nano-banana"
        referenceImages={files} onReferenceImagesChange={onChange} />,
    );
    expect(onChange).toHaveBeenCalledWith(files.slice(0, 3));
    expect(screen.getByRole('status')).toHaveTextContent('参考图最多 3 张，已移除超出的 2 张');
    cleanup();
  });
});

describe('PromptInput 费用展示位置', () => {
  it('输入区不再显示费用，费用只放在生成历史', () => {
    render(
      <PromptInput onSubmit={vi.fn()} providers={[hkKey]} providerAlias="hk" model="gpt-image-2" quality="low" count={3} />,
    );
    expect(screen.queryByTestId('generation-cost-hint')).toBeNull();
    cleanup();
  });
});

describe('PromptInput 键盘提交规范（Enter 出图 / Shift+Enter 换行）', () => {
  function renderForKey() {
    const onSubmit = vi.fn();
    render(
      <PromptInput
        onSubmit={onSubmit}
        providers={[hkKey]}
        providerAlias="hk"
        model="gpt-image-2"
        value="画一只猫"
        onValueChange={vi.fn()}
      />,
    );
    return { onSubmit, editor: screen.getByLabelText('生图 prompt') };
  }

  it('Enter 直接提交', () => {
    const { onSubmit, editor } = renderForKey();
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('画一只猫');
    cleanup();
  });

  it('Shift+Enter 换行不提交', () => {
    const { onSubmit, editor } = renderForKey();
    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    cleanup();
  });

  it('输入法组合期 Enter 不提交（确认候选）', () => {
    const { onSubmit, editor } = renderForKey();
    fireEvent.compositionStart(editor);
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    cleanup();
  });
});

describe('PromptInput 创作资产插入', () => {
  it('把提示词资产插入最后一次编辑光标，不额外添加空格', () => {
    const onValueChange = vi.fn();
    const { rerender } = render(
      <PromptInput
        onSubmit={vi.fn()}
        providers={[hkKey]}
        providerAlias="hk"
        model="gpt-image-2"
        value="前后"
        onValueChange={onValueChange}
      />,
    );
    const editor = screen.getByLabelText('生图 prompt');
    const textNode = editor.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 1);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.mouseUp(editor);

    rerender(
      <PromptInput
        onSubmit={vi.fn()}
        providers={[hkKey]}
        providerAlias="hk"
        model="gpt-image-2"
        value="前后"
        onValueChange={onValueChange}
        insertTextRequest={{ requestId: 'insert-1', text: '资产' }}
      />,
    );

    expect(onValueChange).toHaveBeenLastCalledWith('前资产后');
    cleanup();
  });
});
