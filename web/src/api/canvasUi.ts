import { requestJson } from './http';
import type {
  CanvasImageToolbarPreferences,
  CanvasUiPreferences,
} from '@/schema/canvas';

export function getCanvasUiPreferences(): Promise<CanvasUiPreferences> {
  return requestJson<CanvasUiPreferences>('/api/canvas/ui-preferences', '读取画布界面偏好');
}

export function saveCanvasUiPreferences(
  expectedRevision: number,
  imageToolbar: CanvasImageToolbarPreferences,
): Promise<CanvasUiPreferences> {
  return requestJson<CanvasUiPreferences>('/api/canvas/ui-preferences', '保存画布界面偏好', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expected_revision: expectedRevision, image_toolbar: imageToolbar }),
  });
}
