import { useMemo } from 'react';
import { usePlugins } from '@/plugin-host/registry';
import type { PluginEntry } from '@/schema/plugins';
import ReactMarkdown from 'react-markdown';

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

/** 模型回复常带 Markdown：标题压到正文字号，面板里只用 sm / xs 两档。 */
export function AgentMarkdown({ text }: { text: string }) {
  return (
    <div className="break-words text-sm">
      <ReactMarkdown
        components={{
          h1: ({ node: _node, ...props }) => <p className="my-2 font-medium first:mt-0" {...props} />,
          h2: ({ node: _node, ...props }) => <p className="my-2 font-medium first:mt-0" {...props} />,
          h3: ({ node: _node, ...props }) => <p className="my-2 font-medium first:mt-0" {...props} />,
          p: ({ node: _node, ...props }) => <p className="my-2 first:mt-0 last:mb-0" {...props} />,
          ul: ({ node: _node, ...props }) => <ul className="my-2 list-disc space-y-0.5 pl-4" {...props} />,
          ol: ({ node: _node, ...props }) => <ol className="my-2 list-decimal space-y-0.5 pl-4" {...props} />,
          code: ({ node: _node, ...props }) => <code className="rounded bg-secondary px-1 text-xs" {...props} />,
          pre: ({ node: _node, ...props }) => <pre className="my-2 overflow-x-auto rounded-md bg-secondary p-2 text-xs" {...props} />,
          a: ({ node: _node, ...props }) => <a className="text-primary underline underline-offset-2" target="_blank" rel="noreferrer" {...props} />,
        }}
      >{text}</ReactMarkdown>
    </div>
  );
}
