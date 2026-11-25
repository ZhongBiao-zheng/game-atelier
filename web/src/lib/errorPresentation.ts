import type { KeyView } from '@/api/keys';
import { failureSummary } from '@/lib/failureSummary';
import type { Job, JobErrorCode } from '@/schema/jobs';

/** 失败任务给用户的那一个主修复动作。调用方按 kind 接线（打开供应商设置、换模型、聚焦提示词…）。 */
export type JobErrorActionKind =
  | 'topup'
  | 'open_provider'
  | 'change_model'
  | 'edit_prompt'
  | 'retry'
  | 'requery'
  | 'edit_endpoint'
  | 'reconnect';

export interface JobErrorAction {
  label: string;
  kind: JobErrorActionKind;
  /** 只有外部链接类动作（去充值）带；没有时调用方自己导航。 */
  href?: string;
}

export interface JobErrorPresentation {
  /** 一句中文原因。原文（`job.error`）由调用方收进「查看技术详情」。 */
  message: string;
  action?: JobErrorAction;
}

type ErrorKeySpec = Pick<KeyView, 'homepage_url'>;

const FIXED: Record<Exclude<JobErrorCode, 'insufficient_balance' | 'timeout' | 'unknown'>, JobErrorPresentation> = {
  invalid_key: { message: '供应商密钥无效或已失效', action: { label: '更新密钥', kind: 'open_provider' } },
  model_unavailable: { message: '当前密钥未开通此模型', action: { label: '更换模型', kind: 'change_model' } },
  content_rejected: { message: '提示词或参考图未通过安全审核', action: { label: '修改提示词', kind: 'edit_prompt' } },
  network: { message: '无法连接供应商，请检查网络或代理设置', action: { label: '重试', kind: 'retry' } },
  // 结局不明的提交不给「重试」：再发一次可能重复下单、重复计费。
  submission_unconfirmed: { message: '提交结果未确认，供应商可能已收到并计费' },
  bad_endpoint: { message: '请求地址无效，未找到对应接口', action: { label: '修改地址', kind: 'edit_endpoint' } },
  service_unavailable: { message: 'Atelier 服务无响应', action: { label: '重新连接', kind: 'reconnect' } },
};

/** 失败任务 → 一句原因 + 至多一个修复动作（规格 2.3）。按后端落盘的 `error_code` 选，不再从报错原文猜。
 *
 * `keySpec` 传任务所用的那把供应商（按 `job.alias` 找）；有官网地址时「余额不足」给「去充值」外链，
 * 没有就给「打开供应商」。没有 `error_code` 的旧任务与 `unknown` 显示原文摘要 + 「重试」。 */
export function presentJobError(job: Pick<Job, 'error' | 'error_code' | 'params'>, keySpec?: ErrorKeySpec | null): JobErrorPresentation {
  const code = job.error_code ?? 'unknown';
  if (code === 'insufficient_balance') {
    const href = keySpec?.homepage_url?.trim();
    return {
      message: '供应商余额不足，无法发起生成',
      action: href ? { label: '去充值', kind: 'topup', href } : { label: '打开供应商', kind: 'open_provider' },
    };
  }
  if (code === 'timeout') {
    const hasTask = (job.params.provider_task_ids ?? []).some(Boolean);
    return hasTask
      ? { message: '等待结果超时，未收到产物；任务可能仍在运行', action: { label: '重新查询', kind: 'requery' } }
      : { message: '等待结果超时，未收到产物', action: { label: '重试', kind: 'retry' } };
  }
  if (code !== 'unknown') return FIXED[code];
  return {
    message: job.error ? failureSummary(job.error) : '生成失败',
    action: { label: '重试', kind: 'retry' },
  };
}
