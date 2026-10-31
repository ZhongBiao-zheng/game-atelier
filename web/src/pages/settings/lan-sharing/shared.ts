export const PERIODS = { day: '今日', week: '本周', month: '本月' };
export const KINDS = { image: '图片', image_edit: '编辑', layer_split: '图层', video: '视频', audio: '音频', text: '文本' };
export function date(value: string | null) { return value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'; }
