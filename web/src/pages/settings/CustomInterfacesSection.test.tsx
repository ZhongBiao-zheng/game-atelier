import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CustomInterfacesSection } from './CustomInterfacesSection';

const api = vi.hoisted(() => ({
  listHttpProtocols: vi.fn(),
  deleteHttpProtocol: vi.fn(),
  getHttpProtocol: vi.fn(),
  createHttpProtocol: vi.fn(),
  updateHttpProtocol: vi.fn(),
  validateHttpProtocol: vi.fn(),
}));
vi.mock('@/api/httpProtocols', () => api);

beforeEach(() => {
  Object.values(api).forEach(fn => fn.mockReset());
  api.listHttpProtocols.mockResolvedValue({ protocols: [] });
  api.validateHttpProtocol.mockResolvedValue({ valid: true, issues: [], declared: null, preview: null });
});

it('keeps a visible entry when there is no template yet', async () => {
  render(<CustomInterfacesSection />);
  expect(await screen.findByRole('heading', { name: '自定义接口' })).toBeInTheDocument();
  expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole('button', { name: '新建' }), { key: 'Enter' });
  fireEvent.click(await screen.findByRole('menuitem', { name: '视频接口' }));
  expect(await screen.findByRole('dialog')).toBeInTheDocument();
  expect((screen.getByLabelText('接口模板') as HTMLTextAreaElement).value).toContain('"kind": "video"');
});
