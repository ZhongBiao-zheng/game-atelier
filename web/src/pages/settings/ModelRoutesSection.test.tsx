import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { listModelRoutes, setModelRouteOrder, type ModelRoute } from '@/api/models';
import { ModelRoutesSection } from './ModelRoutesSection';

vi.mock('@/api/models', () => ({ listModelRoutes: vi.fn(), setModelRouteOrder: vi.fn() }));

const member = (alias: string) => ({
  alias, provider: 'custom', base_url: null, model_id: 'gpt-image-2', name: 'gpt-image-2', protocol: null,
});
const shared: ModelRoute = { id: 'gpt-image-2', name: 'gpt-image-2', modality: 'image', members: [member('Tuzi'), member('HK')] };
const single: ModelRoute = { id: 'flux-3', name: 'flux-3', modality: 'image', members: [member('Tuzi')] };

describe('ModelRoutesSection', () => {
  it('只列多家共有的模型，提前一家就保存新顺序', async () => {
    vi.mocked(listModelRoutes).mockResolvedValue([shared, single]);
    vi.mocked(setModelRouteOrder).mockResolvedValue({ ...shared, members: [member('HK'), member('Tuzi')] });
    render(<ModelRoutesSection reloadToken={0} />);

    const order = await screen.findByRole('list', { name: 'gpt-image-2 的供应商顺序' });
    expect(screen.queryByText('flux-3')).not.toBeInTheDocument();
    expect(within(order).getAllByRole('listitem').map(item => item.textContent)).toEqual(['1Tuzi', '2HK']);

    fireEvent.click(screen.getByLabelText('把 HK 提前'));
    expect(setModelRouteOrder).toHaveBeenCalledWith('image', 'gpt-image-2', ['HK', 'Tuzi']);
    await waitFor(() => expect(within(order).getAllByRole('listitem').map(item => item.textContent)).toEqual(['1HK', '2Tuzi']));
  });

  it('没有多家共有的模型时整块不显示', async () => {
    vi.mocked(listModelRoutes).mockResolvedValue([single]);
    const { container } = render(<ModelRoutesSection reloadToken={0} />);
    await waitFor(() => expect(listModelRoutes).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
