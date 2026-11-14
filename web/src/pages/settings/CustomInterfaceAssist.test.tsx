import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { chooseOption } from '@/test/select';
import { CustomInterfaceDialog } from './CustomInterfaceDialog';

const api = vi.hoisted(() => ({
  getHttpProtocol: vi.fn(),
  createHttpProtocol: vi.fn(),
  updateHttpProtocol: vi.fn(),
  validateHttpProtocol: vi.fn(),
  listAssistModels: vi.fn(),
  draftHttpProtocol: vi.fn(),
}));
vi.mock('@/api/httpProtocols', () => api);

const DRAFT = { version: 1, name: 'AI 起草', kind: 'image', auth: { type: 'bearer' },
  submit: { path: '/v2/gen', body: { prompt: '$prompt' } }, result: { urls: ['data.*.url'] } };

beforeEach(() => {
  Object.values(api).forEach(fn => fn.mockReset());
  api.validateHttpProtocol.mockResolvedValue({ valid: true, issues: [], declared: null, preview: null });
  api.listAssistModels.mockResolvedValue({ models: [
    { alias: 'Tuzi', model_id: 'gpt-x', name: 'GPT X', max_cost_cny: null },
    { alias: 'HK', model_id: 'claude-y', name: 'Claude Y', max_cost_cny: 0.31 },
  ] });
  api.draftHttpProtocol.mockResolvedValue({ document: DRAFT, notices: ['资料里有 1 处密钥，已在发送前遮掉'],
    usage: { input_tokens: 1000, output_tokens: 200, cost_cny: null, job_id: 'job-1' } });
  try { window.localStorage.clear(); } catch { /* jsdom */ }
});

const open = () => render(<CustomInterfaceDialog identifier={null} kind="image" onSaved={vi.fn()} onClose={vi.fn()} />);

it('drafts into the editor with a billing label, then undoes back to the previous template', async () => {
  open();
  const editor = screen.getByLabelText('接口模板') as HTMLTextAreaElement;
  const before = editor.value;
  fireEvent.click(screen.getByRole('button', { name: /AI 帮我配置/ }));
  const run = await screen.findByRole('button', { name: '生成（消耗对话额度）' });
  expect(run).toBeDisabled();  // 没有资料不能点
  expect(await screen.findByText('未计价')).toBeInTheDocument();
  await chooseOption(screen.getByLabelText('对话模型'), 'HK · Claude Y');
  expect(screen.getByText('最多约 0.31¥')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('接口文档'), { target: { value: 'POST /v2/gen' } });
  fireEvent.change(screen.getByLabelText('文档网址'), { target: { value: 'https://docs.example/a  https://docs.example/b' } });
  fireEvent.click(run);

  await waitFor(() => expect(editor.value).toContain('"AI 起草"'));
  expect(api.draftHttpProtocol).toHaveBeenCalledWith({ kind: 'image', alias: 'HK', model_id: 'claude-y',
    text: 'POST /v2/gen', urls: ['https://docs.example/a', 'https://docs.example/b'] });
  expect(screen.getByText('资料里有 1 处密钥，已在发送前遮掉')).toBeInTheDocument();
  expect(screen.getByText('本次 1200 tokens · 未计价')).toBeInTheDocument();
  expect(api.createHttpProtocol).not.toHaveBeenCalled();  // 草稿不自动保存

  fireEvent.click(screen.getByRole('button', { name: '撤销' }));
  expect(editor.value).toBe(before);
  expect(screen.queryByRole('button', { name: '撤销' })).not.toBeInTheDocument();
});

it('blocks more than three urls and shows the server error without touching the editor', async () => {
  api.draftHttpProtocol.mockRejectedValue(new Error('模型没有给出可用的 JSON：抱歉'));
  open();
  const editor = screen.getByLabelText('接口模板') as HTMLTextAreaElement;
  const before = editor.value;
  fireEvent.click(screen.getByRole('button', { name: /AI 帮我配置/ }));
  const run = await screen.findByRole('button', { name: '生成（消耗对话额度）' });
  await screen.findByLabelText('对话模型');
  fireEvent.change(screen.getByLabelText('文档网址'), { target: { value: 'a b c d' } });
  expect(run).toBeDisabled();
  fireEvent.change(screen.getByLabelText('文档网址'), { target: { value: '' } });
  fireEvent.change(screen.getByLabelText('接口文档'), { target: { value: 'doc' } });
  fireEvent.click(run);
  expect(await screen.findByRole('alert')).toHaveTextContent('模型没有给出可用的 JSON');
  expect(editor.value).toBe(before);
});

it('disables generation when no chat model is configured', async () => {
  api.listAssistModels.mockResolvedValue({ models: [] });
  open();
  fireEvent.click(screen.getByRole('button', { name: /AI 帮我配置/ }));
  expect(await screen.findByText('没有可用的对话模型')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('接口文档'), { target: { value: 'doc' } });
  expect(screen.getByRole('button', { name: '生成（消耗对话额度）' })).toBeDisabled();
});
