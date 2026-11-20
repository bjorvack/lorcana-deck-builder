/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useApp } from '../state';
import { makeCard } from '../test/fixtures';
import { CardModal, CardTile } from './components';

vi.mock('../state', () => ({ useApp: vi.fn() }));
const mockedUseApp = vi.mocked(useApp);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CardTile image fallback', () => {
  it('falls back to the alt image when the thumb fails', () => {
    const card = makeCard({ id: 1 });
    card.images.alt = 'https://example.com/alt.png';
    render(<CardTile card={card} onOpen={() => {}} />);
    fireEvent.error(screen.getByRole('img'));
    expect(screen.getByRole('img').getAttribute('src')).toBe(
      'https://example.com/alt.png',
    );
  });

  it('shows the placeholder once every image candidate has failed', () => {
    const card = makeCard({ id: 1 });
    card.images.alt = 'https://example.com/alt.png';
    render(<CardTile card={card} onOpen={() => {}} />);
    fireEvent.error(screen.getByRole('img'));
    fireEvent.error(screen.getByRole('img'));
    expect(screen.queryByRole('img')).toBeNull();
    // placeholder (new text node) + tile name
    expect(screen.getAllByText(card.fullName)).toHaveLength(2);
  });

  it('uses the alt image when no thumb exists', () => {
    const card = makeCard({ id: 1 });
    card.images.thumb = undefined;
    card.images.alt = 'https://example.com/alt.png';
    render(<CardTile card={card} onOpen={() => {}} />);
    expect(screen.getByRole('img').getAttribute('src')).toBe(
      'https://example.com/alt.png',
    );
  });
});

describe('CardModal', () => {
  it('surfaces the gated-add refusal reason inline', () => {
    mockedUseApp.mockReturnValue({
      addCard: vi.fn(() => ({
        status: 'refused',
        reason: 'Copy limit reached (4/4 in deck)',
      })),
    } as unknown as ReturnType<typeof useApp>);
    render(<CardModal card={makeCard({ id: 1 })} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add to deck' }));
    expect(screen.getByText('Copy limit reached (4/4 in deck)')).toBeTruthy();
  });

  it('closes on Escape, backdrop click and the Close button', () => {
    const onClose = vi.fn();
    mockedUseApp.mockReturnValue({
      addCard: vi.fn(),
    } as unknown as ReturnType<typeof useApp>);
    const { container } = render(
      <CardModal card={makeCard({ id: 1 })} onClose={onClose} />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(container.querySelector('.modal-backdrop')!);
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('moves focus into the dialog on open', () => {
    mockedUseApp.mockReturnValue({
      addCard: vi.fn(),
    } as unknown as ReturnType<typeof useApp>);
    render(<CardModal card={makeCard({ id: 1 })} onClose={() => {}} />);
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true');
  });
});
