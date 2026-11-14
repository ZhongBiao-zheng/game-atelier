# 快速开始

做一个最小的插件：画布上多一种节点，节点里显示连给它的图片尺寸。

## 1. 建目录与清单

```text
plugins/hello-size/
├── manifest.json
└── ui/src/main.tsx
```

`plugins/hello-size/manifest.json`：

```json
{
  "manifest_version": 1,
  "id": "hello-size",
  "name": "图片尺寸",
  "version": "0.1.0",
  "description": "显示连入图片的尺寸",
  "icon": "grid",
  "publisher": { "id": "atelier", "name": "Atelier" },
  "sdk_version": "1",
  "app_version": { "min": "5.137.0" },
  "ui": { "entry": "ui/index.html" },
  "capabilities": ["node.read_self", "resource.read_inputs"],
  "contributes": {
    "nodes": [{
      "type": "size",
      "title": "图片尺寸",
      "icon": "grid",
      "default_size": { "width": 240, "height": 120 },
      "payload_schema_version": 1,
      "input_modalities": ["image"],
      "max_inputs": 1,
      "surfaces": ["node"]
    }]
  }
}
```

`ui.entry` 固定写 `ui/index.html`：页面外壳由构建脚本生成，插件不写自己的 HTML。

## 2. 写界面

`plugins/hello-size/ui/src/main.tsx`：

```tsx
import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';

import { connect, type PluginClient } from '../../../sdk';

function SizeNode({ client }: { client: PluginClient }) {
  const [text, setText] = useState('连接一张图片');
  useEffect(() => {
    const refresh = async () => {
      const image = (await client.inputs.list()).find(input => input.kind === 'image');
      setText(image ? `${image.width} × ${image.height}` : '连接一张图片');
    };
    void refresh();
    return client.on('inputs.changed', () => void refresh());
  }, [client]);
  return <p>{text}</p>;
}

void connect().then(client => {
  createRoot(document.getElementById('root')!).render(<SizeNode client={client} />);
});
```

`connect()` 等宿主握手，返回类型化的客户端。界面里可以用 React（从宿主的依赖解析），也可以不用框架。

## 3. 构建

```bash
make build
```

它会构建宿主前端，再把每个 `plugins/*/ui` 构建成单文件，生成 `plugins/<id>/package/ui/index.html` 与 `plugins/<id>/package/manifest.lock.json`。只重建插件：

```bash
cd web && node scripts/build-plugins.mjs
```

## 4. 启用与使用

1. 启动 Atelier，打开「设置 / 扩展 / 插件」，打开「图片尺寸」的开关。
2. 打开一个画布，「添加节点」菜单里出现「图片尺寸」。
3. 新节点显示「本项目尚未允许此插件」，点「允许」并确认。
4. 把一张图片连到节点上，节点显示它的尺寸。

## 5. 检查

```bash
uv run python scripts/check_product_plugins.py
cd web && pnpm lint
```

入库前跑 `make verify`：它会做干净构建，并要求 `plugins/*/package` 与源码一致。
