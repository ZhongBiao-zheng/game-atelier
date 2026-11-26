import type { WorkflowInput } from '@/api/keys';
import type { JobParams } from '@/schema/jobs';

type WorkflowValues = NonNullable<JobParams['workflow_inputs']>;

function acceptsWorkflowValue(input: WorkflowInput, value: WorkflowValues[string]): boolean {
  if (input.type === 'image' || input.type === 'mask' || input.type === 'prompt') return false;
  if (value === null || value === '') return !input.required || (input.type === 'seed' && value === null);
  if (input.type === 'select') return input.options.some(option => option.value === value);
  if (input.type === 'boolean') return typeof value === 'boolean';
  if (input.type === 'text') return typeof value === 'string' && Array.from(value).length <= 40000;
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (input.type !== 'float' && !Number.isSafeInteger(value)) return false;
  return (input.type !== 'seed' || value >= 0)
    && (input.min == null || value >= input.min) && (input.max == null || value <= input.max);
}

/** Importing the same workflow on another machine gives it a new model ID but stable control IDs. */
export function compatibleWorkflowValues(inputs: WorkflowInput[] | null | undefined, values?: WorkflowValues): WorkflowValues | undefined {
  if (!inputs || !values) return undefined;
  const kept: WorkflowValues = {};
  for (const input of inputs) {
    const value = values[input.id];
    if (value !== undefined && acceptsWorkflowValue(input, value)) kept[input.id] = value;
  }
  return Object.keys(kept).length ? kept : undefined;
}

export function workflowReferenceError(inputs: WorkflowInput[] | null | undefined, imageCount: number, hasMask: boolean): string | null {
  let imageIndex = 0;
  const missing = (inputs ?? []).filter(input => {
    if (input.type === 'image') return ++imageIndex > imageCount && input.required;
    return input.type === 'mask' && input.required && !hasMask;
  });
  return missing.length ? `需要${missing.map(input => input.label).join('、')}` : null;
}
