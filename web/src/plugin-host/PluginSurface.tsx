import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import type { PluginPackageLock } from '@/schema/plugins';
import {
  HANDSHAKE_TYPE, PLUGIN_PROTOCOL,
  type PluginHandshake, type PluginHostEventMessage, type PluginSurfaceKind,
} from '../../../plugins/sdk/protocol';
import { createBroker, type BrokerOptions } from './broker';
import { fontSlices, loadFontBytes, loadPluginSrcdoc, readTheme, SANDBOX_ATTRIBUTE, watchTheme } from './sandbox';

/** 握手发出后，插件要在这段时间内发来第一条消息，否则判为出错。 */
const READY_TIMEOUT_MS = 5000;

export type PluginSurfaceHost = Omit<BrokerOptions, 'loadFonts' | 'now'>;

/**
 * 插件界面的宿主组件：把核对过的界面包放进沙箱 iframe，并把它的消息交给 broker。
 *
 * `host` 每次渲染都可以是新对象——broker 通过 ref 读最新的一份，iframe 不会因此重建。
 * `nodeSignature` / `inputsSignature` 变化时通知插件重新读取。
 */
export function PluginSurface({ plugin, surface, host, nodeSignature, inputsSignature, interactive, title }: {
  plugin: PluginPackageLock;
  surface: PluginSurfaceKind;
  host: PluginSurfaceHost;
  nodeSignature: string;
  inputsSignature: string;
  /** false 时 iframe 不接收指针事件，拖动、框选、滚轮缩放都归画布。 */
  interactive: boolean;
  title: string;
}) {
  const [srcdoc, setSrcdoc] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const hostRef = useRef(host);
  hostRef.current = host;
  const portRef = useRef<MessagePort | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let active = true;
    setSrcdoc(null);
    setFailure(null);
    loadPluginSrcdoc(plugin).then(html => { if (active) setSrcdoc(html); })
      .catch(error => { if (active) setFailure(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [plugin, attempt]);

  useEffect(() => () => cleanupRef.current?.(), [plugin, attempt]);

  const send = (message: PluginHostEventMessage) => portRef.current?.postMessage(message);
  useEffect(() => { send({ event: 'node.changed', data: null }); }, [nodeSignature]);
  useEffect(() => { send({ event: 'inputs.changed', data: null }); }, [inputsSignature]);

  function connect(frame: HTMLIFrameElement) {
    // 握手之后 iframe 又触发一次 load，说明插件把自己导航走了：页面已经不是核对过的那份，立刻断开。
    if (cleanupRef.current) {
      cleanupRef.current();
      setSrcdoc(null);
      setFailure('插件界面发生了跳转，已停止');
      return;
    }
    const target = frame.contentWindow;
    if (!target) return;
    const channel = new MessageChannel();
    const broker = createBroker({
      capabilities: hostRef.current.capabilities,
      readNode: () => hostRef.current.readNode(),
      writePayload: payload => hostRef.current.writePayload(payload),
      listInputs: () => hostRef.current.listInputs(),
      readInput: (versionId, as) => hostRef.current.readInput(versionId, as),
      loadFonts: loadFontBytes,
    });
    let ready = false;
    const watchdog = window.setTimeout(() => {
      if (!ready) { cleanup(); setSrcdoc(null); setFailure('插件没有响应'); }
    }, READY_TIMEOUT_MS);
    channel.port1.onmessage = event => {
      ready = true;
      void broker.handle(event.data).then(reply => {
        if (reply) channel.port1.postMessage(reply.response, reply.transfer);
      });
    };
    const stopThemeWatch = watchTheme(() => send({ event: 'theme.changed', data: readTheme() }));
    const cleanup = () => {
      window.clearTimeout(watchdog);
      stopThemeWatch();
      broker.close();
      channel.port1.close();
      portRef.current = null;
      cleanupRef.current = null;
    };
    portRef.current = channel.port1;
    cleanupRef.current = cleanup;
    const hello: PluginHandshake = {
      type: HANDSHAKE_TYPE, protocol: PLUGIN_PROTOCOL, nonce: crypto.randomUUID(),
      plugin_id: plugin.id, digest: plugin.digest, surface, theme: readTheme(), fonts: fontSlices(),
    };
    // 沙箱是 opaque origin，没有可写的目标来源；port 只交给这一个窗口。
    target.postMessage(hello, '*', [channel.port2]);
  }

  if (failure) {
    return <div role="alert" className="grid size-full min-h-32 place-items-center gap-2 px-4 text-center text-xs text-muted-foreground">
      <div className="space-y-2">
        <p>插件出错</p>
        <p className="break-all text-subtle-foreground">{failure}</p>
        <Button variant="outline" size="sm" className="nodrag nopan" onClick={() => setAttempt(count => count + 1)}>重试</Button>
      </div>
    </div>;
  }
  if (!srcdoc) return <div role="status" aria-label="插件加载中" className="size-full min-h-32" />;
  return <iframe
    key={`${plugin.digest}:${attempt}`}
    title={title}
    sandbox={SANDBOX_ATTRIBUTE}
    srcDoc={srcdoc}
    referrerPolicy="no-referrer"
    onLoad={event => connect(event.currentTarget)}
    className={`block size-full border-0 bg-transparent ${interactive ? 'nodrag nopan nowheel' : 'pointer-events-none'}`}
  />;
}
