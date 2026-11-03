import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import Dropdown from '../src/components/common/Dropdown';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const options = [
  { value: 1, label: 'Season 1', hint: '10 Episodes · IMDb 8.7' },
  { value: 2, label: 'Season 2', hint: 'Not in your library' },
];

it('shows the full season label and metadata in a portal and supports keyboard selection', () => {
  const change = vi.fn();
  const { container } = render(<div style={{ overflow: 'hidden', width: 160 }}><Dropdown value={1} options={options} onChange={change} ariaLabel="Season" /></div>);
  const trigger = screen.getByRole('button', { name: 'Season' });
  fireEvent.click(trigger);
  const menu = screen.getByRole('listbox');
  expect(container.contains(menu)).toBe(false);
  expect(screen.getByRole('option', { name: 'Season 1, 10 Episodes · IMDb 8.7' })).toBeTruthy();
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  fireEvent.keyDown(trigger, { key: 'Enter' });
  expect(change).toHaveBeenCalledWith(2);
});

it('keeps menus inside the viewport and Escape does not close the surrounding screen', () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 180, bottom: 220, left: 280, right: 420, width: 140, height: 40, x: 280, y: 180, toJSON: () => ({}) });
  vi.stubGlobal('innerHeight', 260);
  vi.stubGlobal('innerWidth', 320);
  const closeScreen = vi.fn();
  window.addEventListener('keydown', closeScreen);
  render(<Dropdown value={1} options={Array.from({ length: 20 }, (_, i) => ({ value: i, label: `Season ${i}`, hint: '10 Episodes' }))} onChange={vi.fn()} ariaLabel="Season" />);
  fireEvent.click(screen.getByRole('button', { name: 'Season' }));
  const menu = screen.getByRole('listbox');
  expect(Number.parseFloat(menu.style.left)).toBeGreaterThanOrEqual(8);
  expect(Number.parseFloat(menu.style.width) + Number.parseFloat(menu.style.left)).toBeLessThanOrEqual(312);
  expect(Number.parseFloat(menu.style.maxHeight)).toBeLessThanOrEqual(168);
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(closeScreen).not.toHaveBeenCalled();
  window.removeEventListener('keydown', closeScreen);
  vi.unstubAllGlobals();
});

it('removes a selected menu immediately even when animation frames are paused', () => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
  const change = vi.fn();
  render(<Dropdown value={1} options={options} onChange={change} ariaLabel="Season" />);
  const trigger = screen.getByRole('button', { name: 'Season' });
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('option', { name: /Season 2/ }));
  expect(change).toHaveBeenCalledWith(2);
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(trigger);
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull();
});
