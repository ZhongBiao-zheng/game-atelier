import { render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';

import { CanvasGenerationMetadata, canvasRetryErrorMessage } from './CanvasGenerationMetadata';
import { ApiError } from '@/api/http';
import type { CanvasGenerationSnapshot, Job } from '@/schema/jobs';

const snapshot: CanvasGenerationSnapshot = {
  snapshot_version: 1,
  surface_node_id: 'config-one',
  result_node_id: 'result-one',
  mode: 'image',
  final_prompt: '电影感雨夜列车，湿润站台反光',
  input_policy: 'all_connected',
  model: 'seedream-5.0-lite',
  provider: 'volcengine',
  alias: 'main-image',
  normalized_params: {
    ratio: '16:9',
    quality: '2K',
    n: 2,
    background: 'opaque',
    preset_id: 'canvas.reverse_prompt',
    preset_version: 1,
    creation_asset_source_title: '雨夜电影感',
    access_key: 'sk-must-not-render',
    debug: {
      path: '/Volumes/Art Drive/private/reference.png',
      endpoint: 'https://example.com/render?access_token=must-not-render&token=second-secret&access_key=query-access&secret_key=query-secret&password=query-password&private_key=query-private&OSSAccessKeyId=oss-access&X-Amz-Credential=aws-credential&X-Amz-Security-Token=aws-token&X-Goog-Credential=gcs-credential&access%5Fkey=encoded-access',
      authenticated_endpoint: 'https://user:password@example.com/v1',
    },
    raw_debug: '{"token":"nested-secret","path":"/Users/artist/private.png"}',
    escaped_debug: '{\\"X-API-Key\\":\\"header-secret\\",\\"client_secret\\":\\"client-secret\\"}',
  },
  inputs: [{
    order: 0,
    source: 'input_connection',
    node_id: 'image-reference',
    version_id: 'version-reference',
    kind: 'image',
  }, {
    order: 1,
    source: 'input_connection',
    node_id: 'deleted-reference',
    version_id: 'version-deleted',
    kind: 'text',
  }],
  mask_version_id: null,
  submitted_at: '2026-08-25T00:00:00Z',
  submitted_by: { kind: 'user', actor_id: null },
  request_fingerprint: 'a'.repeat(64),
};

it('shows the immutable prompt, model parameters, actual output and frozen references', () => {
  const job = {
    params: { actual_size: '2048x1152', warnings: ['厂商自动调整到支持尺寸'] },
  } as Job;
  render(
    <CanvasGenerationMetadata
      snapshot={snapshot}
      job={job}
      nodes={[{ id: 'image-reference', title: '列车构图参考' }]}
    />,
  );

  const record = screen.getByRole('region', { name: '生成记录' });
  expect(within(record).getByText(snapshot.final_prompt)).toBeInTheDocument();
  expect(within(record).getByText('seedream-5.0-lite')).toBeInTheDocument();
  expect(within(record).getByText('16:9')).toBeInTheDocument();
  expect(within(record).getByText('2K')).toBeInTheDocument();
  expect(within(record).getByText('列车构图参考')).toBeInTheDocument();
  expect(within(record).getByText('节点已删除')).toBeInTheDocument();
  expect(within(record).getByText(/deleted-reference · version-deleted/)).toBeInTheDocument();
  expect(within(record).getByText('canvas.reverse_prompt')).toBeInTheDocument();
  expect(within(record).getByText('来源资产')).toBeInTheDocument();
  expect(within(record).getByText('雨夜电影感')).toBeInTheDocument();
  expect(within(record).getByText('2048x1152')).toBeInTheDocument();
  expect(within(record).getByText('厂商自动调整到支持尺寸')).toBeInTheDocument();
  expect(record).not.toHaveTextContent('/Users/');
  expect(record).not.toHaveTextContent('/Volumes/');
  expect(record).not.toHaveTextContent('sk-must-not-render');
  expect(record).not.toHaveTextContent('must-not-render');
  expect(record).not.toHaveTextContent('second-secret');
  expect(record).not.toHaveTextContent('query-access');
  expect(record).not.toHaveTextContent('query-secret');
  expect(record).not.toHaveTextContent('query-password');
  expect(record).not.toHaveTextContent('query-private');
  expect(record).not.toHaveTextContent('oss-access');
  expect(record).not.toHaveTextContent('aws-credential');
  expect(record).not.toHaveTextContent('aws-token');
  expect(record).not.toHaveTextContent('gcs-credential');
  expect(record).not.toHaveTextContent('encoded-access');
  expect(record).not.toHaveTextContent('user:password');
  expect(record).not.toHaveTextContent('nested-secret');
  expect(record).not.toHaveTextContent('/Users/artist');
  expect(record).not.toHaveTextContent('header-secret');
  expect(record).not.toHaveTextContent('client-secret');
  expect(within(record).getByText('敏感值（已隐藏）')).toBeInTheDocument();
  expect(record).toHaveTextContent('本地文件（路径已隐藏）');
});

it('shows the server message together with its recovery hint on retry failure', () => {
  const error = new ApiError(
    '原结果节点已被删除，不能在原位置重试',
    {
      status: 409,
      code: 'result_node_missing',
      reason: '原结果节点已被删除，不能在原位置重试',
      recovery: '恢复结果节点，或新建生成节点后重新提交。',
    },
  );

  expect(canvasRetryErrorMessage(error)).toBe(
    '原结果节点已被删除，不能在原位置重试 恢复结果节点，或新建生成节点后重新提交。',
  );
  expect(canvasRetryErrorMessage(new Error('网络中断'))).toBe('网络中断');
});
