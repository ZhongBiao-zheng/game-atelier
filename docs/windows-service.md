# Windows 中转常驻

先启动一次 Atelier，配置数据目录、供应商和局域网共享。以**当前使用 Atelier 的 Windows 用户**打开管理员 PowerShell，在源码目录（安装包的 `app/` 目录）运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows-service.ps1 install
```

脚本创建 `GameAtelier` 任务并打开任务计划程序。进入「任务计划程序库 → GameAtelier → 属性」，选择「不管用户是否登录都要运行」，点击确定，在系统对话框输入 Windows 登录密码。不要选择「不存储密码」。脚本不读取或保存密码。

运行 `scripts/windows-service.ps1 status`，返回 `installed` 才表示凭据步骤已完成；`needs_credentials` 表示尚未完成。然后右键任务 →「运行」。局域网防火墙仍需允许网关端口。

任务在开机时和每分钟触发；已有任务进程则跳过。进程异常退出后，重试或下一次触发会恢复服务。主服务继续只监听 `127.0.0.1`，外部仅能访问单独启用的网关。

`install` 会单独询问是否禁止接通电源时睡眠，只有输入 Y 才修改。脚本不会修改电池睡眠设置。

卸载常驻任务（停止它并保留全部用户数据）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows-service.ps1 uninstall
```

安装包换目录前先卸载，解压新版本后重新安装任务。手动启动器仍可使用。运行日志位于数据目录 `.runtime/server.log`，按天轮转、保留14份历史；启动阶段原始输出保存在 `.runtime/server-startup.log`。

验收：重启且不登录时，从另一台机器请求 `http://中转地址:端口/gateway/v1/health`，只返回 `ok`、`version`；结束任务中的 Python 进程，观察下一分钟恢复。此步骤需 Windows 真机。
