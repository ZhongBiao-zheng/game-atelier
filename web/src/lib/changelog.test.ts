import { describe, expect, it } from 'vitest';

// ?raw 由 vite 在 transform 期内联，路径按文件位置解析——不依赖测试进程的 cwd
// （make test 从仓库根跑、pnpm test 从 web/ 跑，两种都得过）。
import pluginManifest from '../../../.claude-plugin/plugin.json?raw';
import { CHANGELOG, CURRENT_VERSION, groupChanges, hasUnreadChangelog } from './changelog';

describe('changelog 数据', () => {
  it('最新一条与 plugin.json 的版本一致 —— 两处真值靠这条断言钉死', () => {
    const declared = (JSON.parse(pluginManifest) as { version: string }).version;
    expect(CURRENT_VERSION).toBe(declared);
  });

  it('新版在前、版本号不重复', () => {
    const versions = CHANGELOG.map((e) => e.version);
    expect(new Set(versions).size).toBe(versions.length);
    const rank = (v: string) => v.split('.').map(Number);
    for (let i = 1; i < CHANGELOG.length; i += 1) {
      const [aMaj, aMin, aPat] = rank(versions[i - 1]);
      const [bMaj, bMin, bPat] = rank(versions[i]);
      const newer =
        aMaj > bMaj || (aMaj === bMaj && (aMin > bMin || (aMin === bMin && aPat > bPat)));
      expect(newer, `${versions[i - 1]} 应排在 ${versions[i]} 之前`).toBe(true);
    }
  });

  it('每条都有日期、概括和至少一项改动', () => {
    for (const e of CHANGELOG) {
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.headline.length).toBeGreaterThan(0);
      expect(e.changes.length).toBeGreaterThan(0);
    }
  });
});

describe('改动分组', () => {
  it('固定「先新增、后修复」，与录入顺序无关', () => {
    const grouped = groupChanges([
      { kind: 'fix', text: 'a' },
      { kind: 'feat', text: 'b' },
      { kind: 'fix', text: 'c' },
    ]);
    expect(grouped.map(([k]) => k)).toEqual(['feat', 'fix']);
    expect(grouped[1][1].map((c) => c.text)).toEqual(['a', 'c']);
  });

  it('空的那一类不出现，不留空标题', () => {
    const grouped = groupChanges([{ kind: 'feat', text: 'only' }]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0][0]).toBe('feat');
  });

  it('条目数守恒 —— 分组不吞不重复', () => {
    for (const e of CHANGELOG) {
      const total = groupChanges(e.changes).reduce((n, [, list]) => n + list.length, 0);
      expect(total, `v${e.version}`).toBe(e.changes.length);
    }
  });
});

describe('未读判定', () => {
  it('首次使用不算未读 —— 新用户不该被历史更新拦住', () => {
    expect(hasUnreadChangelog(null)).toBe(false);
  });

  it('读过旧版本后升级算未读', () => {
    expect(hasUnreadChangelog('0.0.1')).toBe(true);
  });

  it('读过当前版本不算未读', () => {
    expect(hasUnreadChangelog(CURRENT_VERSION)).toBe(false);
  });
});
