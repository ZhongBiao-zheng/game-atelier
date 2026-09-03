import { useCallback, useEffect, useRef, useState } from 'react';

import { GitHubIcon } from '@/components/GitHubIcon';
import { ToolbarPopover } from '@/components/studio/ToolbarPopover';
import {
  CHANGELOG,
  CHANGE_KIND_LABEL,
  CURRENT_VERSION,
  PROJECT_GITHUB_URL,
  groupChanges,
  hasUnreadChangelog,
  loadSeenVersion,
  saveSeenVersion,
  type ChangelogEntry,
} from '@/lib/changelog';

function VersionBlock({
  entry,
  isLatest,
  isNew,
}: {
  entry: ChangelogEntry;
  isLatest: boolean;
  isNew: boolean;
}) {
  return (
    <section className={isLatest ? '' : 'border-t border-border pt-6'}>
      {/* 版本号与日期紧邻左对齐：它们是一个语义单元（哪一版、什么时候）。
          日期右对齐会把这对信息拆成两栏，视线要横跨整个面板才配得上。 */}
      <div className="flex items-baseline gap-2">
        {/* 未读时版本号转黄铜色：不额外加「新」标签，省一个元素也省一次阅读 */}
        <span
          className={['font-mono text-xs', isNew ? 'text-primary' : 'text-muted-foreground'].join(
            ' ',
          )}
        >
          v{entry.version}
        </span>
        <span aria-hidden className="text-xs text-muted-foreground/40">
          ·
        </span>
        <time className="text-xs text-muted-foreground/70" dateTime={entry.date}>
          {entry.date}
        </time>
      </div>
      {/* headline 用 serif：本仓把衬线留给「作品的名字」（空状态、角色名），
          每版的主题句用同一手法，日志读起来像画廊展签而不是发版公告 */}
      <h3 className="mt-1 font-display text-base text-foreground">{entry.headline}</h3>

      <div className="mt-4 flex flex-col gap-4">
        {groupChanges(entry.changes).map(([kind, list]) => (
          <div key={kind}>
            <h4
              className={[
                'text-xs',
                kind === 'feat' ? 'text-primary' : 'text-muted-foreground/70',
              ].join(' ')}
            >
              {CHANGE_KIND_LABEL[kind]}
            </h4>
            <ul className="mt-2 flex flex-col gap-2">
              {list.map((c, i) => (
                <li key={i} className="flex gap-2">
                  {/* 发丝圆点：条目常换行到两三行，没有行首标记时上一条的末行会和下一条黏在一起 */}
                  <span
                    aria-hidden
                    className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground/40"
                  />
                  <span className="text-sm text-muted-foreground">{c.text}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

/** 顶栏版本号与仓库入口，更新日志只在主动点击时展开。
 *
 * 未读判定见 lib/changelog：首次使用静默标已读（新用户不该被历史更新拦住），
 * 只有「读过旧版本后升级」才亮圆点。打开即标已读。
 */
export function ChangelogButton() {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(false);
  /** 正文还没滚到底 —— 底部加渐隐，明示下面还有版本 */
  const [fade, setFade] = useState(false);

  useEffect(() => {
    const seen = loadSeenVersion();
    setUnread(hasUnreadChangelog(seen));
    if (seen === null) saveSeenVersion(CURRENT_VERSION);
  }, []);

  const close = useCallback((returnFocus = false) => {
    setOpen(false);
    setUnread(false);
    // 键盘关闭要把焦点送回触发器，否则焦点掉回 body，Tab 得从头再来一遍
    if (returnFocus) anchorRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close(true);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  function toggle() {
    if (open) close();
    else {
      saveSeenVersion(CURRENT_VERSION);
      setOpen(true);
    }
  }

  /** 渐隐只在「能滚且没到底」时挂。ref 回调里也测一次，面板首次渲染就拿到正确状态。 */
  function measure(el: HTMLDivElement | null) {
    if (!el) return;
    setFade(el.scrollHeight - el.scrollTop - el.clientHeight > 8);
  }

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-label={`v${CURRENT_VERSION} 更新日志${unread && !open ? '（有未读更新）' : ''}`}
        title="查看更新日志"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="changelog-trigger"
        onClick={toggle}
        className={[
          'relative inline-flex h-10 shrink-0 items-center justify-center rounded-full px-2 text-sm tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
          open
            ? 'text-primary ring-1 ring-border'
            : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
        ].join(' ')}
      >
        v{CURRENT_VERSION}
        {unread && !open && (
          // ring-background 让圆点与文字分离，暗底浅底都能辨认
          <span
            aria-hidden
            data-testid="changelog-unread-dot"
            className="absolute right-0 top-1 size-1.5 rounded-full bg-primary ring-2 ring-background"
          />
        )}
      </button>

      <a
        href={PROJECT_GITHUB_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="GitHub 项目仓库（新标签页打开）"
        title="GitHub 项目仓库"
        className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <GitHubIcon />
      </a>

      <ToolbarPopover
        open={open}
        onClose={close}
        anchorRef={anchorRef}
        direction="down"
        align="end"
        role="dialog"
        aria-label="更新日志"
        data-testid="changelog-panel"
        // 密集文本不用玻璃：透底会让正文难读（DESIGN.md 组件配方同「选项弹窗」一条）
        className="popover-in flex max-h-[70vh] w-96 max-w-[calc(100vw-1.5rem)] flex-col rounded-xl border border-border bg-card"
      >
        {/* 标题栏不跟着滚：滚到第三个版本时仍要知道自己在读什么、当前是哪一版 */}
        <div className="flex shrink-0 items-baseline justify-between gap-3 border-b border-border px-5 pb-4 pt-5">
          <h2 className="text-base font-medium text-foreground">更新日志</h2>
          <span className="font-mono text-xs text-muted-foreground/70">当前 v{CURRENT_VERSION}</span>
        </div>
        <div
          ref={measure}
          onScroll={(e) => measure(e.currentTarget)}
          data-testid="changelog-body"
          className={[
            'flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto stable-scroll px-5 pb-5 pt-4',
            fade ? 'scroll-fade-b' : '',
          ].join(' ')}
        >
          {CHANGELOG.map((e, i) => (
            <VersionBlock key={e.version} entry={e} isLatest={i === 0} isNew={unread && i === 0} />
          ))}
        </div>
      </ToolbarPopover>
    </>
  );
}
