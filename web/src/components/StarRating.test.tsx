import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StarRating } from './StarRating';

describe('StarRating', () => {
  it('点右半区设整星', async () => {
    const onChange = vi.fn();
    render(<StarRating value={0} onChange={onChange} />);
    await userEvent.click(screen.getByLabelText('4 星'));
    expect(onChange).toHaveBeenCalledWith(4);
  });
  it('点左半区设半星', async () => {
    const onChange = vi.fn();
    render(<StarRating value={0} onChange={onChange} />);
    await userEvent.click(screen.getByLabelText('3.5 星'));
    expect(onChange).toHaveBeenCalledWith(3.5);
  });
  it('点当前值清零', async () => {
    const onChange = vi.fn();
    render(<StarRating value={4} onChange={onChange} />);
    await userEvent.click(screen.getByLabelText('4 星'));
    expect(onChange).toHaveBeenCalledWith(0);
  });
});
