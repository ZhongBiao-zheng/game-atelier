import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PromptInput } from '@/components/studio/PromptInput';
import type { KeyView } from '@/api/keys';
import { checkComfyUI } from '@/api/comfyui';
import { withAutoProvider } from '@/lib/modelRoutes';
import { localComfyUrl } from '@/lib/useComfyStatus';

vi.mock('@/api/comfyui', async original => ({
  ...await original<typeof import('@/api/comfyui')>(),
  checkComfyUI: vi.fn(),
}));

const localKey: KeyView = {
  alias: 'ComfyUI',
  provider: 'comfyui',
  base_url: 'http://127.0.0.1:8188',
  access_key: '',
  secret_key: null,
  capabilities: [],
  notes: '',
  created_at: '',
  models: [{ id: 'comfyui-upscale', name: '放大', modality: 'image', workflow_inputs: [] }],
};

beforeEach(() => {
  vi.mocked(checkComfyUI).mockReset();
});

afterEach(cleanup);

describe('localComfyUrl', () => {
  it('只识别本机 ComfyUI 及其智能路由直连成员，排除局域网网关', () => {
    expect(localComfyUrl(localKey, localKey.models[0])).toBe('http://127.0.0.1:8188');

    const autoLocal = withAutoProvider([localKey], [{
      id: 'comfyui-upscale', name: '放大', modality: 'image', mode: 'order', candidate_alias: 'ComfyUI',
      members: [{ alias: 'ComfyUI', provider: 'comfyui', base_url: 'http://127.0.0.1:8188', model_id: 'comfyui-upscale', name: '放大', protocol: 'comfyui' }],
    }]);
    expect(localComfyUrl(autoLocal[0], autoLocal[0].models[0])).toBe('http://127.0.0.1:8188');

    const gatewayKey: KeyView = {
      ...localKey, alias: '团队网关', provider: 'atelier', base_url: 'http://192.168.1.9:5180',
      models: [{
        ...localKey.models[0],
        via: [{ alias: 'host', provider: 'comfyui', model_id: 'comfyui-upscale', name: '放大', base_url: null, protocol: 'comfyui' }],
      }],
    };
    expect(localComfyUrl(gatewayKey, gatewayKey.models[0])).toBeNull();

    const autoGateway = withAutoProvider([gatewayKey], [{
      id: 'comfyui-upscale', name: '放大', modality: 'image', mode: 'order', candidate_alias: '团队网关',
      members: [{ alias: '团队网关', provider: 'atelier', base_url: gatewayKey.base_url, model_id: 'comfyui-upscale', name: '放大', protocol: null, via: gatewayKey.models[0].via }],
    }]);
    expect(localComfyUrl(autoGateway[0], autoGateway[0].models[0])).toBeNull();
  });
});

describe('PromptInput ComfyUI 状态探测', () => {
  it('未启动时提示并允许点击重检，恢复后隐藏且不锁死生成按钮', async () => {
    vi.mocked(checkComfyUI)
      .mockRejectedValueOnce(new Error('主机的 ComfyUI 未启动'))
      .mockResolvedValueOnce({ devices: [] });

    render(<PromptInput providers={[localKey]} providerAlias="ComfyUI" model="comfyui-upscale" onSubmit={vi.fn()} />);

    const hint = await screen.findByTestId('comfy-stopped-hint');
    expect(hint).toHaveTextContent('ComfyUI 未启动');
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();

    fireEvent.click(hint);
    await waitFor(() => expect(screen.queryByTestId('comfy-stopped-hint')).not.toBeInTheDocument());
    expect(checkComfyUI).toHaveBeenCalledTimes(2);
  });

  it('非本机 ComfyUI 渠道不发起探测请求', () => {
    const cloud: KeyView = {
      ...localKey, alias: 'OpenAI', provider: 'openai', base_url: 'https://api.openai.com/v1',
      models: [{ id: 'gpt-image-2', name: 'GPT Image', modality: 'image' }],
    };
    render(<PromptInput providers={[cloud]} providerAlias="OpenAI" model="gpt-image-2" onSubmit={vi.fn()} />);
    expect(checkComfyUI).not.toHaveBeenCalled();
  });
});
