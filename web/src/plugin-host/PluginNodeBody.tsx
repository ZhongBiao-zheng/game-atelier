import { useMemo, useState } from 'react';
import { Link } from 'wouter';

import { canvasMediaUrl } from '@/api/canvas';
import { ApiError, request, requestJson } from '@/api/http';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Hint } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { HelpIcon, PluginIcon, pluginIcon } from '@/components/ui/icons';
import type { CanvasContentVersion, CanvasNode, CanvasPluginNode } from '@/schema/canvas';
import { PluginServerError, type BrokerInput } from './broker';
import { useProjectGrants } from './grants';
import { PluginSurface, type PluginSurfaceHost } from './PluginSurface';
import { clearPluginPanelRequest, usePluginPanelRequested } from './panelRequests';
import { usePlugins } from './registry';

export interface PluginNodeInput { nodeId: string; title: string; versionId: string | null }

/** 批准弹窗里那一句话：按插件声明的能力拼出它要做的事。 */
const CAPABILITY_PHRASES: Array<[string, string]> = [
  ['resource.read_inputs', '读取连到它的素材内容'],
  ['resource.create', '在画布上新建内容'],
  ['node.write_self', '保存它自己的节点数据'],
];
function capabilitySentence(capabilities: readonly string[]): string {
  const phrases = CAPABILITY_PHRASES.filter(([capability]) => capabilities.includes(capability)).map(([, phrase]) => phrase);
  return phrases.length > 0 ? `它会${phrases.join('、')}。` : '它只显示自己的界面。';
}
/** 「?」里的说明：如实告知插件能拿到什么。 */
function capabilityDetail(capabilities: readonly string[]): string {
  const lines = ['插件在隔离环境里运行，读不到其他节点、其他项目和你的密钥。'];
  if (capabilities.includes('resource.read_inputs')) lines.push('你连到它的素材，它能读到完整内容（包括已隐藏的节点）。');
  if (capabilities.includes('server.call')) lines.push('它会把这些素材交给本机上自己的处理模块。');
  return lines.join('');
}

function Placeholder({ icon: Icon = PluginIcon, reason, children }: {
  icon?: typeof PluginIcon; reason: string; children?: React.ReactNode;
}) {
  return <div className="grid size-full min-h-44 place-items-center px-4 text-center">
    <div className="space-y-2.5">
      <Icon size="xl" aria-hidden className="mx-auto text-subtle-foreground" />
      <p className="text-xs text-muted-foreground">{reason}</p>
      {children}
    </div>
  </div>;
}

/**
 * 插件节点的内容区。插件可用且本项目已批准时渲染沙箱界面；其余情况显示宿主占位。
 * 占位状态下节点的数据原样保留，仍可移动、复制、删除。
 */
export function PluginNodeBody({ node, projectId, inputs, resolveVersion, updateNode, recordHistory }: {
  node: CanvasPluginNode;
  projectId: string;
  /** 保留给宿主传入；内容面不随选中改变行为。 */
  selected?: boolean;
  inputs: readonly PluginNodeInput[];
  resolveVersion: (versionId: string | null | undefined) => CanvasContentVersion | undefined;
  updateNode: (id: string, updater: (node: CanvasNode) => CanvasNode) => void;
  recordHistory: () => void;
}) {
  const plugins = usePlugins();
  const entry = plugins.find(plugin => plugin.id === node.data.plugin_id);
  const manifest = entry?.enabled ? entry.manifest : null;
  const contribution = manifest?.contributes.nodes.find(item => item.type === node.data.node_type);
  // 插件的启用状态或版本变了，批准要重新读一次（能力增加时原批准不再有效）。
  const { grants, grant } = useProjectGrants(projectId, `${manifest?.digest ?? ''}`);
  const [confirming, setConfirming] = useState(false);
  const [granting, setGranting] = useState(false);
  const [grantError, setGrantError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  // 工具栏动作建完节点后会请求打开面板；批准通过后才真正打开，关闭时清掉请求。
  const requested = usePluginPanelRequested(node.id);

  const granted = manifest ? grants?.[manifest.id] : undefined;
  const capabilities = useMemo(() => new Set(granted?.capabilities ?? []), [granted]);
  const brokerInputs = useMemo<BrokerInput[]>(() => inputs.flatMap(input => {
    const version = resolveVersion(input.versionId);
    if (!version || !input.versionId) return [];
    // 清单没声明要收的素材类型不交给插件，即使文档里有这条连线。
    if (!contribution?.input_modalities.includes(version.kind)) return [];
    const media = version.kind === 'text' ? null : version;
    return [{ versionId: input.versionId, kind: version.kind, title: input.title,
      width: media?.width ?? null, height: media?.height ?? null }];
  // eslint-disable-next-line react-hooks/exhaustive-deps -- resolveVersion 是常量引用；输入变了 inputs 会换引用
  }), [inputs, contribution]);

  if (!entry) return <Placeholder reason="未安装此插件" />;
  if (!manifest) {
    return <Placeholder reason={entry.availability === 'ok' ? '插件未启用' : (entry.reason ?? '插件不可用')}>
      {entry.availability === 'ok' && <Button asChild variant="outline" size="sm" className="nodrag nopan">
        <Link href="/settings/plugins">启用</Link>
      </Button>}
    </Placeholder>;
  }
  if (!contribution || !contribution.surfaces.includes('node')) return <Placeholder reason="此版本的插件不支持这个节点" />;
  if (grants === null) return <div role="status" aria-label="插件加载中" className="size-full min-h-44" />;
  if (!granted) {
    return <Placeholder icon={pluginIcon(manifest.icon)} reason="本项目尚未允许此插件">
      <Button variant="outline" size="sm" className="nodrag nopan" disabled={granting} onClick={() => setConfirming(true)}>允许</Button>
      {grantError && <p role="alert" className="text-xs text-destructive">{grantError}</p>}
      <AlertDialog open={confirming} onOpenChange={open => { if (!open) setConfirming(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              在本项目使用「{manifest.name}」？
              <Hint label={capabilityDetail(manifest.capabilities)}>
                <Button variant="ghost" size="icon" type="button" aria-label="插件能做什么" className="size-7 text-muted-foreground"><HelpIcon size="sm" aria-hidden /></Button>
              </Hint>
            </AlertDialogTitle>
            <AlertDialogDescription>{capabilitySentence(manifest.capabilities)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              setConfirming(false);
              setGranting(true);
              setGrantError(null);
              grant(manifest.id).catch(error => setGrantError(error instanceof Error ? error.message : String(error)))
                .finally(() => setGranting(false));
            }}>允许</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Placeholder>;
  }

  const host: PluginSurfaceHost = {
    capabilities,
    readNode: () => ({
      node_type: node.data.node_type, title: node.title,
      size: node.size ?? contribution.default_size,
      payload_schema_version: node.data.data_schema_version, payload: node.data.payload,
    }),
    writePayload: payload => {
      recordHistory();
      // 只改这一个节点，而且只在它仍是同一个插件的节点时才改。
      updateNode(node.id, current => current.type === 'plugin' && current.data.plugin_id === manifest.id
        ? { ...current, data: { ...current.data, payload: payload as CanvasPluginNode['data']['payload'] } }
        : current);
    },
    listInputs: () => brokerInputs,
    readInput: async (versionId, as) => {
      const version = resolveVersion(versionId);
      if (!version) throw new Error('missing version');
      if (version.kind === 'text') return version.text;
      const response = await request(canvasMediaUrl(projectId, versionId), '读取素材');
      return as === 'bitmap' ? createImageBitmap(await response.blob()) : response.arrayBuffer();
    },
    callServer: async (path, params, versionIds) => {
      try {
        // 服务端不信这里：它会重新核对插件是否启用、项目是否批准、节点与素材的归属。
        const body = await requestJson<{ result: unknown }>(
          `/api/plugins/${encodeURIComponent(manifest.id)}/routes${path}`, manifest.name, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project_id: projectId, node_id: node.id, inputs: versionIds, params }),
          });
        return body.result;
      } catch (error) {
        if (error instanceof ApiError && error.reason) throw new PluginServerError(error.reason);
        throw error;
      }
    },
  };
  const hasPanel = contribution.surfaces.includes('panel');
  const showPanel = hasPanel && (panelOpen || requested);
  const closePanel = () => { setPanelOpen(false); clearPluginPanelRequest(node.id); };
  const nodeSignature = JSON.stringify([node.data.payload, node.size, node.title]);
  const inputsSignature = brokerInputs.map(input => input.versionId).join(',');
  // 节点内容面不接收指针：拖动、框选、缩放都归画布。双击打开编辑面板。
  return <div className="relative size-full min-h-44" onDoubleClick={() => { if (hasPanel) setPanelOpen(true); }}>
    <PluginSurface plugin={manifest} surface="node" host={host} title={node.title} interactive={false}
      nodeSignature={nodeSignature} inputsSignature={inputsSignature} />
    <Dialog open={showPanel} onOpenChange={open => { if (!open) closePanel(); }}>
      <DialogContent className="flex h-[min(46rem,calc(100dvh-4rem))] max-w-5xl flex-col gap-3 p-4" aria-describedby={undefined}
        onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
        <DialogTitle className="pr-10 text-base font-medium">{node.title}</DialogTitle>
        <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border">
          {showPanel && <PluginSurface plugin={manifest} surface="panel" host={{ ...host, closeSurface: closePanel }}
            title={`${node.title} 编辑面板`} interactive nodeSignature={nodeSignature} inputsSignature={inputsSignature} />}
        </div>
      </DialogContent>
    </Dialog>
  </div>;
}
