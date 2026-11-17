import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { checkComfyUI, listWorkflows } from '@/api/comfyui';
import { createKey, getChatGPTSubscription, listKeys, type KeyView } from '@/api/keys';
import { listHttpProtocols } from '@/api/httpProtocols';
import { recordOnboardingEvent } from '@/api/onboarding';
import { OnboardingGuide } from './OnboardingGuide';
import { FirstRunGuide } from './FirstRunGuide';

vi.mock('@/api/keys', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/keys')>(),
  createKey: vi.fn(),
  listKeys: vi.fn(),
  getChatGPTSubscription: vi.fn(),
}));
vi.mock('@/api/comfyui', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/comfyui')>(),
  checkComfyUI: vi.fn(),
  listWorkflows: vi.fn(),
}));
vi.mock('@/api/httpProtocols', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/httpProtocols')>(),
  listHttpProtocols: vi.fn(),
}));
vi.mock('@/api/onboarding', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/onboarding')>(),
  recordOnboardingEvent: vi.fn(),
}));

const keyView = (overrides: Partial<KeyView>): KeyView => ({
  alias: 'k', provider: 'custom', base_url: null, access_key: '', secret_key: null,
  capabilities: [], notes: '', created_at: '2026-11-17T00:00:00Z', models: [], ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getChatGPTSubscription).mockResolvedValue({ available: true, email: 'artist@example.com', plan: 'plus' });
  vi.mocked(checkComfyUI).mockResolvedValue({ devices: [] });
  vi.mocked(listWorkflows).mockResolvedValue({ workflows: [] });
  vi.mocked(listHttpProtocols).mockResolvedValue({ protocols: [] });
  vi.mocked(createKey).mockResolvedValue({ alias: 'x' });
  vi.mocked(recordOnboardingEvent).mockResolvedValue();
  vi.mocked(listKeys).mockResolvedValue({ keys: [] });
});

it('lays out the recommended provider and the three key-free paths with their live status', async () => {
  render(<OnboardingGuide source="model_chip" onDone={vi.fn()} />);
  const recommended = within(screen.getByRole('list', { name: '推荐' })).getAllByRole('button');
  expect(recommended.map(card => card.textContent)).toEqual([
    expect.stringMatching(/^Tuzi推荐GPT Image · Nano Banana · 视频$/),
    expect.stringMatching(/^TokenDance推荐Seedream · 视频 · 语音$/),
  ]);
  const others = screen.getByRole('list', { name: '其他方式' });
  expect(await within(others).findByText('artist@example.com')).toBeInTheDocument();
  expect(await within(others).findByText('运行中')).toBeInTheDocument();
  expect(within(others).getByText('加入团队')).toBeInTheDocument();
  expect(recordOnboardingEvent).toHaveBeenCalledWith({ event: 'guide_opened', source: 'model_chip' });
});

it('walks the recommended steps and opens the key form on the last one', async () => {
  render(<OnboardingGuide source="first_run" onDone={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: /^Tuzi/ }));
  const steps = screen.getByRole('list', { name: '获取 Key 步骤' });
  const rows = within(steps).getAllByRole('listitem');
  expect(rows[0]).toHaveAttribute('aria-current', 'step');
  const signup = within(rows[0]).getByRole('link', { name: /打开/ });
  expect(signup).toHaveAttribute('href', 'https://api.tu-zi.com/register');
  expect(signup).toHaveAttribute('target', '_blank');
  fireEvent.click(signup);
  expect(within(rows[0]).getByText('已完成')).toBeInTheDocument();
  expect(rows[1]).toHaveAttribute('aria-current', 'step');
  expect(within(rows[2]).getByLabelText('创建 Key说明')).toBeInTheDocument();
  expect(recordOnboardingEvent).toHaveBeenCalledWith({ event: 'path_selected', path: 'key', vendor: 'tuzi' });
  expect(recordOnboardingEvent).toHaveBeenCalledWith({ event: 'step_opened', step: 'signup', vendor: 'tuzi' });

  fireEvent.click(within(rows[3]).getByRole('button', { name: '粘贴' }));
  const form = await screen.findByRole('dialog');
  expect(within(form).getByRole('heading', { name: 'Tuzi' })).toBeInTheDocument();
  expect(within(form).getByRole('button', { name: '保存并开始' })).toBeDisabled();
  expect(recordOnboardingEvent).toHaveBeenCalledWith({ event: 'step_opened', step: 'key_form', vendor: 'tuzi' });
});

it('gives TokenDance its own steps, hints and key form', async () => {
  render(<OnboardingGuide source="first_run" onDone={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: /^TokenDance/ }));
  const rows = within(screen.getByRole('list', { name: '获取 Key 步骤' })).getAllByRole('listitem');
  expect(rows.map(row => within(row).queryByRole('link')?.getAttribute('href'))).toEqual([
    'https://tokendance.space/login', 'https://tokendance.space/credits', 'https://tokendance.space/keys', undefined,
  ]);
  expect(within(rows[0]).getByLabelText('注册说明')).toBeInTheDocument();
  expect(recordOnboardingEvent).toHaveBeenCalledWith({ event: 'path_selected', path: 'key', vendor: 'tokendance' });
  fireEvent.click(screen.getByRole('button', { name: '返回' }));
  expect(screen.getByRole('list', { name: '推荐' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /^TokenDance/ }));
  fireEvent.click(screen.getByRole('button', { name: '粘贴' }));
  const form = await screen.findByRole('dialog');
  expect(within(form).getByRole('heading', { name: 'TokenDance' })).toBeInTheDocument();
});

it('finishes once a ChatGPT subscription is saved', async () => {
  const onDone = vi.fn();
  render(<OnboardingGuide source="first_run" onDone={onDone} />);
  fireEvent.click(await screen.findByRole('button', { name: /ChatGPT 订阅/ }));
  const form = await screen.findByRole('dialog');
  vi.mocked(listKeys).mockResolvedValue({ keys: [keyView({ alias: 'chatgpt', provider: 'chatgpt',
    models: [{ id: 'gpt-image-2', name: 'GPT Image', modality: 'image' }] })] });
  await waitFor(() => expect(within(form).getByRole('button', { name: '保存并开始' })).toBeEnabled());
  fireEvent.click(within(form).getByRole('button', { name: '保存并开始' }));
  await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
  expect(createKey).toHaveBeenCalledWith(expect.objectContaining({ provider: 'chatgpt', auth_source: 'codex-cli' }));
  expect(recordOnboardingEvent).toHaveBeenCalledWith({ event: 'provider_saved', path: 'chatgpt' });
});

it('moves a saved ComfyUI without workflows straight to importing one', async () => {
  const onDone = vi.fn();
  render(<OnboardingGuide source="first_run" onDone={onDone} />);
  fireEvent.click(screen.getByRole('button', { name: /本机 ComfyUI/ }));
  const form = await screen.findByRole('dialog');
  expect(within(form).getByText('保存后导入工作流')).toBeInTheDocument();
  vi.mocked(listKeys).mockResolvedValue({ keys: [keyView({ alias: 'ComfyUI', provider: 'comfyui', base_url: 'http://127.0.0.1:8188' })] });
  fireEvent.click(within(form).getByRole('button', { name: '保存并开始' }));
  // 新建弹窗卸载、编辑弹窗挂上；按钮要在整页里找，不能拿旧弹窗节点。
  const done = await screen.findByRole('button', { name: '完成' });
  expect(within(screen.getByRole('dialog')).queryByText('保存后导入工作流')).not.toBeInTheDocument();
  expect(screen.getByRole('dialog')).toContainElement(done);
  await waitFor(() => expect(listWorkflows).toHaveBeenCalledWith('ComfyUI'));
  expect(onDone).not.toHaveBeenCalled();
});

it('records the skip before leaving the first-run step', async () => {
  const onComplete = vi.fn();
  render(<FirstRunGuide onComplete={onComplete} />);
  fireEvent.click(screen.getByRole('button', { name: '稍后' }));
  await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
  expect(recordOnboardingEvent).toHaveBeenCalledWith({ event: 'skipped' });
});
