import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HOVER_DELAY_MS, useHoverIntent } from '../src/components/home/MediaCard';
import { useLibraryStore } from '../src/store/useLibraryStore';
import { buildItems } from '../src/store/selectors';
import type { MediaItem } from '../src/types/media';
import { movie } from './fixtures';

vi.mock('../src/services/torrents', () => ({ torrentForItem: vi.fn(), formatEta: vi.fn(), formatExpiryRemaining: vi.fn(), formatSpeed: vi.fn() }));

function Card({ item }: { item: MediaItem }) {
  const hover = useHoverIntent(() => ({ item }));
  return <div {...hover} data-testid="card" />;
}

beforeEach(() => {
  vi.useFakeTimers();
  useLibraryStore.setState(useLibraryStore.getInitialState(), true);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 200, bottom: 340, left: 50, right: 250, width: 200, height: 140, x: 50, y: 200, toJSON: () => ({}) });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('uses updated metadata if a library reload arrives during hover intent', () => {
  const item = buildItems([movie], [], new Map())[0];
  const { rerender } = render(<Card item={item} />);
  fireEvent.mouseEnter(screen.getByTestId('card'));
  rerender(<Card item={{ ...item, title: 'Updated title' }} />);
  act(() => { vi.advanceTimersByTime(HOVER_DELAY_MS); });
  expect(useLibraryStore.getState().hover?.item.title).toBe('Updated title');
});

it('can reopen a preview dismissed by scrolling without requiring a new mouseenter', () => {
  render(<Card item={buildItems([movie], [], new Map())[0]} />);
  const card = screen.getByTestId('card');
  fireEvent.mouseEnter(card);
  act(() => { vi.advanceTimersByTime(HOVER_DELAY_MS); });
  expect(useLibraryStore.getState().hover).not.toBeNull();
  act(() => useLibraryStore.getState().setHover(null));
  fireEvent.mouseMove(card);
  act(() => { vi.advanceTimersByTime(HOVER_DELAY_MS); });
  expect(useLibraryStore.getState().hover).not.toBeNull();
});
