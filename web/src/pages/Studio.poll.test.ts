import { describe, expect, it, vi } from 'vitest';

// Studio.tsx 顶部 import 了这些；提供占位 fn 防止模块求值时 undefined 调用。
vi.mock('@/api/studio', () => ({
  getStudioJob: vi.fn(),
  createStudioJob: vi.fn(),
  listStudioJobs: vi.fn(),
  uploadReferenceImage: vi.fn(),
}));

import * as Studio from './Studio';

describe('Studio polling removal (P2-9)', () => {
  it('no longer exports pollJobUntilTerminal — 终态翻面走 SSE 定向更新', () => {
    expect('pollJobUntilTerminal' in Studio).toBe(false);
  });
});
