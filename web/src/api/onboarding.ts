import { requestJson } from './http';
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
}

export async function fetchOnboardingStatus(): Promise<OnboardingState> {
  return requestJson<OnboardingState>('/api/onboarding/status', '读取初始化状态');
}

export async function setDataRoot(path: string): Promise<{ data_root: string }> {
  return requestJson<{ data_root: string }>('/api/onboarding/data-root', '设置数据目录', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
}
