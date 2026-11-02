import type { WorkflowInput } from '@/api/keys';

export function workflowReferenceError(inputs: WorkflowInput[] | null | undefined, imageCount: number, hasMask: boolean): string | null {
  let imageIndex = 0;
  const missing = (inputs ?? []).filter(input => {
    if (input.type === 'image') return ++imageIndex > imageCount && input.required;
    return input.type === 'mask' && input.required && !hasMask;
  });
  return missing.length ? `需要${missing.map(input => input.label).join('、')}` : null;
}
