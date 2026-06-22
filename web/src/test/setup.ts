import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';

// 跨测试文件隔离。vitest 在低核 CI（ubuntu runner）上会复用 worker：多个测试
// 文件在同一进程、共享同一个 jsdom document 顺序执行。本地多核则每文件独立
// worker、document 互不可见——所以下面这类污染只在 CI 复现、本地恒过，表现为
// “只有 CI 红” 的假 flaky。
//
// 两类残留：
//   1. DOM 残留：RTL 渲染的节点（含 createPortal 到 document.body 的弹窗）若上
//      一个文件没卸干净，会累积进下个文件的 document，导致 "Found multiple
//      [data-testid=...]" 或查询命中错节点（本仓 Home 紧凑菜单测试即栽于此）。
//   2. localStorage 残留：持久化选择（Studio 的 studio:selection）跨文件泄漏。
// 全局每例前后清场，根除整类，不依赖各文件自觉。
beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});
