import { expect, it, vi } from 'vitest';
import { connectionFetch } from './connection';
import { previewModels } from './keys';

vi.mock('./connection', async original => ({
  ...await original<typeof import('./connection')>(), connectionFetch: vi.fn(),
}));

it.each([
  [502, '上游 404: Not Found'],
  [502, '目录 405：Method Not Allowed'],
  [502, '上游 405: Method Not Allowed'],
] as const)('offers manual entry for an unavailable list (%s, %s)', async (status, detail) => {
  vi.mocked(connectionFetch).mockResolvedValueOnce(Response.json({ detail }, { status }));
  await expect(previewModels({})).rejects.toMatchObject({ message: '这个供应商不提供模型列表，请手动添加' });
});

it.each([
  [404, '找不到别名「测试」的密钥（可能已被删除）'],
  [502, '上游 401: Unauthorized'],
  [502, '上游 500: 关联请求返回 404'],
] as const)('keeps other list diagnostics (%s, %s)', async (status, detail) => {
  vi.mocked(connectionFetch).mockResolvedValueOnce(Response.json({ detail }, { status }));
  await expect(previewModels({})).rejects.toMatchObject({ message: `拉取模型列表失败：${detail}（HTTP ${status}）` });
});
