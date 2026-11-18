// The macOS menu bar. Clipboard and window items use system roles, so they act on the focused text
// field exactly as in any Mac app; the page sees key presses first and keeps its own shortcuts.
// Windows has no menu bar (docs/contracts/desktop-shell.md 「菜单与图标」).
import { Menu } from 'electron';

export function buildMenu(name, actions) {
  return Menu.buildFromTemplate([
    {
      label: name,
      submenu: [
        { role: 'about', label: `关于 ${name}` },
        { type: 'separator' },
        { label: '设置…', accelerator: 'CmdOrCtrl+,', click: actions.settings },
        { type: 'separator' },
        { role: 'hide', label: `隐藏 ${name}` },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        // Not role 'quit': the shell's quit flow stops the server it started and asks first
        // while work is running.
        { label: `退出 ${name}`, accelerator: 'CmdOrCtrl+Q', click: actions.quit },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '显示',
      submenu: [
        { label: '重新载入', accelerator: 'CmdOrCtrl+R', click: actions.reload },
        { label: '实际大小', accelerator: 'CmdOrCtrl+0', click: actions.actualSize },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '进入全屏幕' },
      ],
    },
    {
      label: '窗口',
      role: 'window',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { type: 'separator' },
        { role: 'close', label: '关闭窗口' },
      ],
    },
    {
      label: '帮助',
      role: 'help',
      submenu: [{ label: '查看日志', click: actions.openLog }],
    },
  ]);
}
