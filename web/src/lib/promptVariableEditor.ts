import { hasPromptVariableContent, promptVariableParts, promptVariableToken, type PromptVariable } from './promptVariables';

/** Native inputs inside atomic spans keep IME, selection and input undo native. */
export function variablePromptNodes(prompt: string, textNodes: (text: string) => Node[]): Node[] {
  return promptVariableParts(prompt).flatMap(part => part.kind === 'text'
    ? textNodes(part.text) : [variableNode(part.variable)]);
}

function variableNode(variable: PromptVariable): HTMLElement {
  const wrapper = document.createElement('span');
  wrapper.setAttribute('contenteditable', 'false');
  wrapper.dataset.promptVariable = promptVariableToken(variable);
  wrapper.className = 'mx-0.5 inline-block max-w-full align-baseline';
  const input = document.createElement('input');
  input.type = 'text';
  input.dataset.variableName = variable.name;
  input.setAttribute('aria-label', `变量：${variable.name}`);
  input.setAttribute('aria-required', String(!hasPromptVariableContent(variable.example)));
  input.placeholder = variable.example || variable.name;
  input.title = variable.name;
  input.value = variable.value;
  input.defaultValue = variable.value;
  input.className = 'max-w-full rounded border border-input bg-secondary/50 px-1.5 py-0.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary';
  sizeVariable(input);
  wrapper.append(input);
  return wrapper;
}

function sizeVariable(input: HTMLInputElement) {
  // CJK characters occupy roughly two Latin character cells.
  const length = [...(input.value || input.placeholder)].reduce((n, char) => n + (/[^\x00-\x7F]/.test(char) ? 2 : 1), 0);
  input.style.width = `${Math.min(36, Math.max(8, length + 2))}ch`;
}

export function variableInput(target: EventTarget | null): HTMLInputElement | null {
  return target instanceof HTMLInputElement && target.dataset.variableName !== undefined ? target : null;
}

/** Update duplicates without replacing the active DOM/input or moving its caret. */
export function syncVariableInput(editor: HTMLElement, target: EventTarget | null): boolean {
  const input = variableInput(target);
  if (!input) return false;
  editor.querySelectorAll<HTMLElement>('[data-prompt-variable]').forEach(wrapper => {
    const field = wrapper.querySelector<HTMLInputElement>('input');
    if (!field || field.dataset.variableName !== input.dataset.variableName) return;
    const part = promptVariableParts(wrapper.dataset.promptVariable ?? '')[0];
    if (part?.kind !== 'variable') return;
    wrapper.dataset.promptVariable = promptVariableToken({ ...part.variable, value: input.value });
    if (field !== input) field.value = input.value;
    field.defaultValue = input.value;
    sizeVariable(field);
  });
  return true;
}

export function focusEmptyVariable(editor: HTMLElement, requiredOnly = false): boolean {
  const input = [...editor.querySelectorAll<HTMLInputElement>('input[data-variable-name]')].find(field =>
    !hasPromptVariableContent(field.value) && (!requiredOnly || field.getAttribute('aria-required') === 'true'));
  input?.focus({ preventScroll: true });
  return Boolean(input);
}
