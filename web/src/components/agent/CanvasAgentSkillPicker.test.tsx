import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { CanvasAgentSkill } from '@/schema/canvas';
import { CanvasAgentSkillPicker } from './CanvasAgentSkillPicker';

const skill = (name: string, builtin: boolean): CanvasAgentSkill =>
  ({ name, description: name + ' 说明', has_scripts: false, builtin });

function open(skills: CanvasAgentSkill[]) {
  render(<CanvasAgentSkillPicker skills={skills} selected={null} onSelect={vi.fn()} onChanged={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '选择 Skill' }));
  return screen.getByRole('listbox', { name: 'Skill 列表' });
}

it('只列出用户导入的 Skill，内置技能由 Agent 自行按需加载', () => {
  const list = open([skill('model-seedream', true), skill('我的海报配方', false)]);
  expect(within(list).getByRole('option', { name: /我的海报配方/ })).toBeInTheDocument();
  expect(within(list).queryByRole('option', { name: /model-seedream/ })).toBeNull();
});

it('只有内置技能时显示空列表提示', () => {
  const list = open([skill('model-seedream', true)]);
  expect(within(list).queryAllByRole('option')).toHaveLength(0);
  expect(within(list).getByText('还没有导入 Skill')).toBeInTheDocument();
});
