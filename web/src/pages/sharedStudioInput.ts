import type { CanvasFrozenGeneration, CanvasFrozenInput } from '@/schema/canvas';

// Studio consumes the handoff once, after the destination session and its model list are ready.
export type SharedStudioInput =
  | { kind: 'reference'; file: File; title: string }
  | { kind: 'prompt'; generation: CanvasFrozenGeneration; inputs: {row: CanvasFrozenInput; file: File}[] };

let pending: SharedStudioInput | undefined;

export function setSharedStudioInput(value: SharedStudioInput) { pending = value; }
export function takeSharedStudioInput() {
  const value = pending;
  pending = undefined;
  return value;
}
