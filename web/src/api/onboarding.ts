import { request, requestJson } from './http';
import type { GuideVendor } from '@/lib/onboardingGuide';
export type OnboardingStatus =
  | 'ready'
  | 'needs_data_root'
  | 'needs_first_key'
  | 'needs_keys_repair';

export interface OnboardingState {
  status: OnboardingStatus;
  data_root: string | null;
  uv_path: string | null;
  venv_python: string | null;
  platform: 'darwin' | 'linux' | 'win32';
  next_action: string;
  runtime_mode?: 'source' | 'bundle';
  update?: { current: string; latest: string | null; update_available: boolean } | null;
  /** 首启第二步（连接模型）点过「稍后」。 */
  onboarding_skipped?: boolean;
}

export async function fetchOnboardingStatus(signal?: AbortSignal): Promise<OnboardingState> {
  return requestJson<OnboardingState>('/api/onboarding/status', '读取初始化状态', signal ? { signal } : undefined);
}

export async function setDataRoot(path: string): Promise<{ data_root: string }> {
  return requestJson<{ data_root: string }>('/api/onboarding/data-root', '设置数据目录', {
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

/** 引导里粘贴密钥后的有效性提示；失败一律当 unknown，不拦保存。 */
export function probeKey(preset: string, accessKey: string): Promise<KeyProbeResult> {
  return requestJson<{ result: KeyProbeResult }>('/api/onboarding/key-probe', '检测密钥', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preset, access_key: accessKey }),
  }).then(body => body.result, () => 'unknown' as const);
}
