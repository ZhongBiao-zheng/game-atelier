import { request, requestJson } from './http';
import type { GuideVendor } from '@/lib/onboardingGuide';
/** 服务端已把「缺数据目录」静默补成默认目录、把损坏的 keys.json 备份成空库，前端只见这两态。 */
export type OnboardingStatus = 'ready' | 'needs_first_key';

export interface OnboardingState {
  status: OnboardingStatus;
  data_root: string | null;
  uv_path: string | null;
  venv_python: string | null;
  platform: 'darwin' | 'linux' | 'win32';
  next_action: string;
  runtime_mode?: 'source' | 'bundle';
  update?: { current: string; latest: string | null; update_available: boolean } | null;
  /** 首启「连接模型」点过「稍后」。 */
  onboarding_skipped?: boolean;
  /** keys.json 损坏后自动备份的记录；添加第一个供应商后清除。 */
  keys_recovered?: { backup: string; at: string } | null;
}

export async function fetchOnboardingStatus(signal?: AbortSignal): Promise<OnboardingState> {
  return requestJson<OnboardingState>('/api/onboarding/status', '读取初始化状态', signal ? { signal } : undefined);
}

export interface DataRootMove {
  phase: 'idle' | 'copying' | 'verifying' | 'done' | 'failed';
  mode: 'copy' | 'switch' | null;
  target: string | null;
  total_bytes: number;
  copied_bytes: number;
  error: string | null;
  detail: string | null;
}

export interface DataRootState {
  data_root: string;
  move: DataRootMove;
}

export function fetchDataRoot(): Promise<DataRootState> {
  return requestJson<DataRootState>('/api/data-root', '读取数据目录');
}

/** 更换数据目录：空目标复制后切换、已有 Atelier 数据直接切换；复制在后台进行，用 fetchDataRoot 看进度。 */
export function changeDataRoot(path: string): Promise<DataRootState> {
  return requestJson<DataRootState>('/api/data-root', '更换数据目录', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
}

export type OnboardingPath = 'key' | 'chatgpt' | 'comfyui' | 'gateway' | 'other';
export type OnboardingEvent =
  | { event: 'guide_opened'; source: 'first_run' | 'model_chip' | 'providers' }
  | { event: 'path_selected'; path: OnboardingPath; vendor?: GuideVendor }
  | { event: 'step_opened'; step: 'signup' | 'topup' | 'key_page' | 'key_form'; vendor?: GuideVendor }
  | { event: 'models_detected'; count: number }
  | { event: 'key_probed'; result: KeyProbeResult }
  | { event: 'provider_saved'; path: OnboardingPath; vendor?: GuideVendor }
  | { event: 'skipped' }
  | { event: 'closed' };

/** 本机度量，只存 `<data_root>/.runtime/onboarding.json`；写不进去也不影响引导本身。 */
export function recordOnboardingEvent(event: OnboardingEvent): Promise<void> {
  return request('/api/onboarding/events', '记录引导事件', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  }).then(() => undefined, () => undefined);
}

export type KeyProbeResult = 'ok' | 'invalid' | 'unknown';

/** 粘贴密钥后的有效性提示；失败一律当 unknown，不拦保存。
 *  baseUrl 是表单当前的请求地址：与该预置的默认地址不一致时服务端不发探针。 */
export function probeKey(preset: string, accessKey: string, baseUrl: string): Promise<KeyProbeResult> {
  return requestJson<{ result: KeyProbeResult }>('/api/onboarding/key-probe', '检测密钥', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preset, access_key: accessKey, base_url: baseUrl }),
  }).then(body => body.result, () => 'unknown' as const);
}
