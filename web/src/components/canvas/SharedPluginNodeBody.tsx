import { hostNodeType, useHostPlugins, type SharedPluginNodeProps } from '@/plugin-host/hostPlugins';

export function SharedPluginNodeBody(props: SharedPluginNodeProps) {
  const Body = hostNodeType(useHostPlugins(), props.node)?.SharedBody;
  return Body ? <Body {...props} /> : (
    <p className="p-3 text-xs text-muted-foreground">插件节点 · 仅查看</p>
  );
}
