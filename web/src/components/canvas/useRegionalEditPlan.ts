import { useEffect, useState } from 'react';
import { previewCanvasEdit, type CanvasEditPlan } from '@/api/canvas';
import { editMaskBlob, type EditStroke } from './imageEditGeometry';

export function useRegionalEditPlan(input: {
  enabled: boolean; projectId?: string; nodeId?: string; versionId: string; alias: string; model: string;
  width: number; height: number; strokes: EditStroke[];
  context: number; feather: number | null; groups: number[][] | null;
}) {
  const fingerprint = JSON.stringify(input);
  const [result, setResult] = useState<{ fingerprint: string; plan?: CanvasEditPlan; error?: string; mask?: Blob }>();
  useEffect(() => {
    const value: typeof input = JSON.parse(fingerprint);
    if (!value.enabled || !value.strokes.length || !value.projectId || !value.nodeId) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const mask = await editMaskBlob(value.width, value.height, value.strokes);
        if (controller.signal.aborted) return;
        const plan = await previewCanvasEdit(value.projectId!, value.nodeId!, value.alias, value.model,
          mask, { mode: 'inpaint', source_version_id: value.versionId, context: value.context,
            feather: value.feather, groups: value.groups }, controller.signal);
        if (!controller.signal.aborted) setResult({ fingerprint, plan, mask });
      } catch (error) {
        if (!controller.signal.aborted) setResult({ fingerprint, error: (error as Error).message });
      }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [fingerprint]);
  const current = result?.fingerprint === fingerprint ? result : undefined;
  return { plan: current?.plan, mask: current?.mask, error: current?.error,
    planning: input.enabled && input.strokes.length > 0 && !current };
}
