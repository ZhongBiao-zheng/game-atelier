import { memo, useMemo } from 'react';
import { usePlugins } from '@/plugin-host/registry';
import type { PluginEntry } from '@/schema/plugins';
import ReactMarkdown, { type Components } from 'react-markdown';

// 与服务端 canvas_agent_runtime.READ_LABELS 同名同字：只读工具的消息正文就是这个标签，相同则不重复显示。
export const TOOL_LABELS: Record<string, string> = {
  model: '对话模型',
  search_library: '查找参考素材',
  get_canvas: '读取画布',
  list_models: '查看可用模型',
  apply_changes: '修改画布',
  run_generation: '生成',
  run_generations: '批量生成',
  update_plan: '更新待办',
  get_run: '查询生成进度',
  read_media: '读取媒体信息',
  read_video_frames: '查看视频画面',
  check_run: '核对生成结果',
  wait_for_run: '等待生成结果',
  wait_for_runs: '等待多个生成结果',
  search_team: '查找团队库参考',
  read_spec: '读取类别规范',
  append_lesson: '记录项目经验',
  load_skill: '读取技能',
  read_skill_file: '读取技能文件',
};

export function agentToolLabels(plugins: readonly PluginEntry[]): Record<string, string> {
  const labels = { ...TOOL_LABELS };
  for (const { manifest } of plugins) {
    if (!manifest) continue;
    for (const tool of manifest.contributes.agent_tools ?? []) {
      labels[`plugin_${manifest.id.replace(/-/g, '_')}_${tool.name}`] = manifest.name;
    }
  }
  return labels;
}

export function useAgentToolLabels() {
  const plugins = usePlugins();
  return useMemo(() => agentToolLabels(plugins), [plugins]);
}

/** 运行中的工具状态行：运行态「{动宾短语}…」，下一段文字到达后原位换成完成态「已{动宾短语}」。
 *  TOOL_LABELS 与服务端同名同字不能改，这里只换状态行的说法：对话模型说「思考中」，插件说「调用 X」。 */
export function agentToolStatusLabel(tool: string, labels: Record<string, string>, running: boolean): string {
  if (tool === 'model') return running ? '思考中…' : '已思考';
  if (tool === 'run_generation') return running ? '提交生成…' : '已提交生成';
  const label = labels[tool] ?? tool;
  if (tool.startsWith('plugin_')) return running ? `调用 ${label}…` : `已执行 ${label}`;
  return running ? `${label}…` : `已${label}`;
}

/** 模型回复常带 Markdown：标题压到正文字号，面板里只用 sm / xs 两档。
 *  memo：历史消息的文本不变就不重新解析，流式输出时只有正在增长的尾段重算。 */
export const AgentMarkdown = memo(function AgentMarkdown({ text }: { text: string }) {
  return (
    <div className="break-words text-sm">
      <ReactMarkdown components={MARKDOWN_COMPONENTS}>{text}</ReactMarkdown>
    </div>
  );
});

const MARKDOWN_COMPONENTS: Components = {
  h1: ({ node: _node, ...props }) => <p className="my-2 font-medium first:mt-0" {...props} />,
  h2: ({ node: _node, ...props }) => <p className="my-2 font-medium first:mt-0" {...props} />,
  h3: ({ node: _node, ...props }) => <p className="my-2 font-medium first:mt-0" {...props} />,
  p: ({ node: _node, ...props }) => <p className="my-2 first:mt-0 last:mb-0" {...props} />,
  ul: ({ node: _node, ...props }) => <ul className="my-2 list-disc space-y-0.5 pl-4" {...props} />,
  ol: ({ node: _node, ...props }) => <ol className="my-2 list-decimal space-y-0.5 pl-4" {...props} />,
  code: ({ node: _node, ...props }) => <code className="rounded bg-secondary px-1 text-xs" {...props} />,
  pre: ({ node: _node, ...props }) => <pre className="my-2 overflow-x-auto rounded-md bg-secondary p-2 text-xs" {...props} />,
  a: ({ node: _node, ...props }) => <a className="text-primary underline underline-offset-2" target="_blank" rel="noreferrer" {...props} />,
};

/** 流式输出的末尾光标：静态，不闪不动，只标出「还在写」。 */
const STREAM_CURSOR = '▍';

/** 切出已经写完的段落：最后一个空行之前、且代码围栏已经闭合的部分不会再变。 */
export function splitStreamingMarkdown(text: string): [stable: string, tail: string] {
  let index = text.lastIndexOf('\n\n');
  while (index > 0) {
    const stable = text.slice(0, index);
    if ((stable.match(/```/g)?.length ?? 0) % 2 === 0) return [stable, text.slice(index + 2)];
    index = text.lastIndexOf('\n\n', index - 1);
  }
  return ['', text];
}

/** 流式回复：写完的段落与正在写的尾段分开渲染。服务端按块推送，每次只有尾段重新解析；
 *  不做逐字入场动画（会让末行高频闪烁），末尾一个静态光标。 */
export function AgentStreamingMarkdown({ text }: { text: string }) {
  const [stable, tail] = splitStreamingMarkdown(text);
  return (
    <div className="space-y-2">
      {stable && <AgentMarkdown text={stable} />}
      <AgentMarkdown text={tail + STREAM_CURSOR} />
    </div>
  );
}
