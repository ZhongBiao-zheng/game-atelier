import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Input } from './input';
import { SecretInput } from './secret-input';
import { Textarea } from './textarea';

describe('shared input privacy defaults', () => {
  it.each([Input, Textarea, SecretInput])('opts out by default and preserves explicit caller attributes', Component => {
    const view = render(<Component aria-label="field" />);
    const field = screen.getByLabelText('field');
    expect(field).toHaveAttribute('autocomplete', 'off');
    expect(field).toHaveAttribute('data-1p-ignore', '');
    expect(field).toHaveAttribute('data-lpignore', 'true');
    expect(field).toHaveAttribute('data-form-type', 'other');
    view.rerender(<Component aria-label="field" autoComplete="on" data-1p-ignore="false" data-lpignore="false" data-form-type="custom" />);
    expect(field).toHaveAttribute('autocomplete', 'on');
    expect(field).toHaveAttribute('data-1p-ignore', 'false');
    expect(field).toHaveAttribute('data-lpignore', 'false');
    expect(field).toHaveAttribute('data-form-type', 'custom');
  });

  it('masks secrets with a text field instead of a password field', () => {
    const view = render(<SecretInput aria-label="secret" />);
    const field = screen.getByLabelText('secret');
    expect(field).toHaveAttribute('type', 'text');
    expect(field).toHaveClass('[-webkit-text-security:disc]');
    view.rerender(<SecretInput aria-label="secret" revealed />);
    expect(field).not.toHaveClass('[-webkit-text-security:disc]');
  });
});
