import { memo, useMemo, useRef } from 'react';
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
  run_group: '整体执行',
  list_templates: '查看模板',
  add_template: '添加模板',
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

/** 流式分段的扫描进度：只向前推进，每次只看新到的完整行。 */
export interface StreamingMarkdownScan {
  text: string;
  /** 已扫描到的位置，总在行首。 */
  offset: number;
  /** 未闭合的代码围栏：``` 或 ~~~ 及其长度，闭合围栏要同字符且不短于它。 */
  fence: { char: string; length: number } | null;
  /** 围栏外空行之后的位置：下一行确认是顶格的新块才成为切分点。 */
  pendingBoundary: number | null;
  /** 已确认的切分点：之前的部分不会再变。 */
  boundary: number;
}

const FENCE_PATTERN = /^\s*(`{3,}|~{3,})(.*)$/;

function emptyScan(text: string): StreamingMarkdownScan {
  return { text, offset: 0, fence: null, pendingBoundary: null, boundary: 0 };
}

/** 从上次的进度接着扫：文本只在末尾追加时不回头；不是追加（换了回复）就从头扫。
 *  切分点只落在围栏外的空行之后、且下一行顶格开始新块时；缩进续行（列表续段、缩进代码）不切。 */
export function scanStreamingMarkdown(text: string, previous?: StreamingMarkdownScan): StreamingMarkdownScan {
  const scan = previous && text.startsWith(previous.text) ? { ...previous, text } : emptyScan(text);
  let lineStart = scan.offset;
  for (let lineEnd = text.indexOf('\n', lineStart); lineEnd !== -1; lineEnd = text.indexOf('\n', lineStart)) {
    const line = text.slice(lineStart, lineEnd);
    const fence = FENCE_PATTERN.exec(line);
    if (scan.fence) {
      if (fence && fence[1][0] === scan.fence.char && fence[1].length >= scan.fence.length && !fence[2].trim()) {
        scan.fence = null;
      }
    } else if (!line.trim()) {
      scan.pendingBoundary = lineEnd + 1;
    } else {
      if (scan.pendingBoundary !== null && !/^\s/.test(line)) scan.boundary = scan.pendingBoundary;
      scan.pendingBoundary = null;
      // 反引号围栏的信息串里不能再有反引号，否则是行内代码。
      if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
        scan.fence = { char: fence[1][0], length: fence[1].length };
      }
    }
    lineStart = lineEnd + 1;
  }
  scan.offset = lineStart;
  // 正在写的行：首字一到就知道是不是顶格的新块，不必等整行写完。
  if (!scan.fence && scan.pendingBoundary !== null && lineStart < text.length && !/\s/.test(text[lineStart])) {
    scan.boundary = scan.pendingBoundary;
    scan.pendingBoundary = null;
  }
  return scan;
}

/** 切出已经写完的块：确认的切分点之前不会再变；未闭合的围栏整体留在尾段。 */
export function splitStreamingMarkdown(text: string, scan = scanStreamingMarkdown(text)): [stable: string, tail: string] {
  return [text.slice(0, scan.boundary).trimEnd(), text.slice(scan.boundary)];
}

/** 流式回复：写完的段落与正在写的尾段分开渲染。服务端按块推送，每次只有尾段重新解析；
 *  不做逐字入场动画（会让末行高频闪烁），末尾一个静态光标。 */
export function AgentStreamingMarkdown({ text }: { text: string }) {
  const scanRef = useRef<StreamingMarkdownScan | undefined>(undefined);
  const scan = scanStreamingMarkdown(text, scanRef.current);
  scanRef.current = scan;
  const [stable, tail] = splitStreamingMarkdown(text, scan);
  return (
    <div className="space-y-2">
      {stable && <AgentMarkdown text={stable} />}
      <AgentMarkdown text={tail + STREAM_CURSOR} />
    </div>
  );
}
