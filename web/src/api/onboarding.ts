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
  const r = await fetch('/api/onboarding/status');
  if (!r.ok) throw new Error(`onboarding/status failed: ${r.status}`);
  return r.json();
}

export async function setDataRoot(path: string): Promise<{ data_root: string }> {
  const r = await fetch('/api/onboarding/data-root', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`set data root failed ${r.status}: ${body}`);
  }
  return r.json();
}
