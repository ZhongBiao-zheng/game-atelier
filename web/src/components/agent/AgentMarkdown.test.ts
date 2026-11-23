import { expect, it } from 'vitest';
import lock from '../../../../plugins/ps-bridge/package/manifest.lock.json';
import type { PluginPackageLock } from '@/schema/plugins';
import { agentToolLabels } from './AgentMarkdown';

it('uses plugin manifest display names in tool history', () => {
  const manifest = lock as unknown as PluginPackageLock;
  const labels = agentToolLabels([{ id: manifest.id, enabled: false, availability: 'ok', reason: null, manifest }]);
  expect(labels.plugin_ps_bridge_inspect).toBe(manifest.name);
  expect(labels.search_team).toBe('查找团队库参考');
});
