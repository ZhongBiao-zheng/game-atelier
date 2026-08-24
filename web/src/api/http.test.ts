import { expect, it } from 'vitest';

import { ApiError, apiError } from './http';

it('preserves a stable server error code and recovery instruction', async () => {
  const response = new Response(JSON.stringify({
    detail: {
      code: 'snapshot_input_missing',
      message: '原生成使用的输入版本已经不存在',
      recovery: '检查历史输入，或按当前设置再次生成。',
    },
  }), { status: 409, statusText: 'Conflict' });

  const error = await apiError(response, '按原设置重试');

  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({
    code: 'snapshot_input_missing',
    status: 409,
    reason: '原生成使用的输入版本已经不存在',
    recovery: '检查历史输入，或按当前设置再次生成。',
  });
  expect(error.message).toContain('原生成使用的输入版本已经不存在');
});
