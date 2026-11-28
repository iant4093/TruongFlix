import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import BackToTop, { BACK_TO_TOP_SCREENS, backToTopVisible } from '../src/components/common/BackToTop';
import { useLibraryStore } from '../src/store/useLibraryStore';

/** A scrolling element standing in for the page, so nothing here leans on `window`. */
function makeScroller(height = 800) {
  const el = document.createElement('div');
  let top = 0;
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => height });
  Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => { top = v; } });
  el.scrollTo = vi.fn((options?: ScrollToOptions | number) => { if (typeof options === 'object') top = options.top ?? top; }) as typeof el.scrollTo;
  document.body.appendChild(el);
  const scrollTo = (y: number) => act(() => { top = y; el.dispatchEvent(new Event('scroll')); });
  return { el, scrollTo };
}

beforeEach(() => useLibraryStore.setState(useLibraryStore.getInitialState(), true));
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  document.documentElement.className = '';
  document.documentElement.removeAttribute('style');
});

it('shows only once the page is scrolled well past a screen', () => {
  expect(backToTopVisible(0, 800)).toBe(false);
  expect(backToTopVisible(800 * BACK_TO_TOP_SCREENS, 800)).toBe(false);
  expect(backToTopVisible(800 * BACK_TO_TOP_SCREENS + 1, 800)).toBe(true);
  // No layout yet (zero height): never shown.
  expect(backToTopVisible(5000, 0)).toBe(false);
});

it('appears past the threshold, scrolls its container to the top, and leaves at the top', async () => {
  const { el, scrollTo } = makeScroller(800);
  const scroller = () => el;
  render(<BackToTop scroller={scroller} />);
  expect(screen.queryByRole('button', { name: 'Back to top' })).toBeNull();

  scrollTo(1000);
  await new Promise((r) => setTimeout(r, 30));
  expect(screen.queryByRole('button', { name: 'Back to top' })).toBeNull();

  scrollTo(2000);
  const button = await screen.findByRole('button', { name: 'Back to top' });
  fireEvent.click(button);
  expect(el.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));

  scrollTo(0);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Back to top' })).toBeNull());
});

it('hides while a dialog or the player covers the page', async () => {
  const { el, scrollTo } = makeScroller(800);
  const scroller = () => el;
  render(<BackToTop scroller={scroller} />);
  scrollTo(3000);
  await screen.findByRole('button', { name: 'Back to top' });

  act(() => document.documentElement.classList.add('nf-scroll-locked'));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Back to top' })).toBeNull());

  act(() => document.documentElement.classList.remove('nf-scroll-locked'));
  await screen.findByRole('button', { name: 'Back to top' });

  act(() => document.documentElement.classList.add('player-mode'));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Back to top' })).toBeNull());
});
