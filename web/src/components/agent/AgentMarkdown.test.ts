import { expect, it } from 'vitest';
import lock from '../../../../plugins/ps-bridge/package/manifest.lock.json';
import type { PluginPackageLock } from '@/schema/plugins';
import { agentToolLabels, scanStreamingMarkdown, splitStreamingMarkdown } from './AgentMarkdown';

it('uses plugin manifest display names in tool history', () => {
  const manifest = lock as unknown as PluginPackageLock;
  const labels = agentToolLabels([{ id: manifest.id, enabled: false, availability: 'ok', reason: null, manifest }]);
  expect(labels.plugin_ps_bridge_inspect).toBe(manifest.name);
  expect(labels.search_team).toBe('查找团队库参考');
});

it('streams fenced code as one tail block until the matching fence closes', () => {
  const open = '前言\n\n~~~js\nconst a = 1;\n\n# comment\n';
  expect(splitStreamingMarkdown(open)).toEqual(['前言', '~~~js\nconst a = 1;\n\n# comment\n']);
  // 更短的围栏、另一种围栏字符都不闭合。
  const nested = '````md\n```\n\n~~~\n\n# 仍在代码里\n';
  expect(splitStreamingMarkdown(nested)).toEqual(['', nested]);
  const closed = nested + '````\n\n后文';
  expect(splitStreamingMarkdown(closed)).toEqual(['````md\n```\n\n~~~\n\n# 仍在代码里\n````', '后文']);
});

it('keeps indented continuations with their block and scans appended text forward', () => {
  expect(splitStreamingMarkdown('- 一\n\n  续段\n')).toEqual(['', '- 一\n\n  续段\n']);
  const first = scanStreamingMarkdown('段一\n\n段二\n');
  expect(first.offset).toBe('段一\n\n段二\n'.length);
  const next = scanStreamingMarkdown('段一\n\n段二\n\n```\n', first);
  expect(splitStreamingMarkdown(next.text, next)).toEqual(['段一\n\n段二', '```\n']);
  // 换了一条回复（不是追加）就从头扫。
  expect(scanStreamingMarkdown('别的\n', next).boundary).toBe(0);
});
