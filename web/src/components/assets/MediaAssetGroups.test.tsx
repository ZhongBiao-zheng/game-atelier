import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { groupMediaAssets, MediaAssetGroups } from './MediaAssetGroups';
import type { CreationAsset } from '@/schema/creationAssets';
const asset = (id: string, project_ids: string[], updated_at = '2026-11-04') => ({ asset_id: id, title: id, kind: 'media', project_ids, updated_at,
  content: { kind: 'media', mime_type: 'image/png', filename: id, sha256: 'a'.repeat(64) }, tags: [] }) as unknown as CreationAsset;
const projects = [{ projectId: 'a', name: '项目甲' }, { projectId: 'b', name: '项目乙' }];
it('多项目重复展示，失去全部项目归属的条目放最后，当前项目优先', () => {
  const groups = groupMediaAssets([asset('both', ['a', 'b']), asset('gone', ['deleted']), asset('none', []), asset('recent', ['b'], '2026-11-05')], projects, 'a');
  expect(groups.map(g => g.id)).toEqual(['a', 'b', 'unassigned']);
  expect(groups[0].assets.map(a => a.asset_id)).toEqual(['both']);
  expect(groups[1].assets.map(a => a.asset_id)).toEqual(['both', 'recent']);
  expect(groups[2].assets.map(a => a.asset_id)).toEqual(['gone', 'none']);
  expect(groupMediaAssets([asset('one', ['a']), asset('two', ['b'], '2026-11-05')], projects).map(g => g.id)).toEqual(['b', 'a']);
});
it('按项目记住折叠状态，筛选后没有资产的项目不展示', () => {
  localStorage.clear();
  const view = render(<MediaAssetGroups assets={[asset('one', ['a']), asset('none', [])]} projects={projects} staleness={{}} onOpen={() => {}} />);
  const toggle = screen.getByRole('button', { name: '项目甲 1' });
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  view.unmount();
  render(<MediaAssetGroups assets={[asset('one', ['a']), asset('none', [])]} projects={projects} staleness={{}} onOpen={() => {}} />);
  expect(screen.getByRole('button', { name: '项目甲 1' })).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('region', { name: '项目乙' })).toBeNull();
});

it('只有一个分组时直接展示资产，即使之前折叠也不隐藏', () => {
  localStorage.clear();
  const view = render(<MediaAssetGroups assets={[asset('one', ['a']), asset('none', [])]} projects={projects} staleness={{}} onOpen={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: '项目甲 1' }));
  view.rerender(<MediaAssetGroups assets={[asset('one', ['a'])]} projects={projects} staleness={{}} onOpen={() => {}} />);
  expect(screen.queryByRole('button', { name: '项目甲 1' })).toBeNull();
  expect(screen.getByRole('button', { name: 'one' })).toBeInTheDocument();
});
