import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import CatalogDialog from '../src/components/browse/CatalogDialog';
import ConfirmDialog from '../src/components/common/ConfirmDialog';
import Dropdown from '../src/components/common/Dropdown';
import LiveDialog from '../src/components/live/LiveDialog';
import { useLibraryStore } from '../src/store/useLibraryStore';

afterEach(cleanup);

function NestedDialogs() {
  const [outer, setOuter] = useState(false);
  const [inner, setInner] = useState(false);
  return <>
    <button onClick={() => setOuter(true)}>Open title</button>
    <CatalogDialog title="Title" onClose={() => setOuter(false)} active={outer}>
      <button onClick={() => setInner(true)}>Open source settings</button>
      <button disabled>Disabled title action</button>
    </CatalogDialog>
    <LiveDialog title="Source settings" onClose={() => setInner(false)} active={inner}>
      <Dropdown value={1} options={[{ value: 1, label: 'First source' }, { value: 2, label: 'Second source' }]} onChange={vi.fn()} ariaLabel="Source" />
      <button hidden>Hidden source action</button>
    </LiveDialog>
  </>;
}

it('keeps focus and backdrop dismissal on the top dialog and restores each opener', () => {
  render(<NestedDialogs />);
  const titleButton = screen.getByRole('button', { name: 'Open title' });
  titleButton.focus();
  fireEvent.click(titleButton);
  const outer = screen.getByRole('dialog', { name: 'Title' });
  expect(document.activeElement).toBe(outer);
  const sourceButton = screen.getByRole('button', { name: 'Open source settings' });
  sourceButton.focus();
  fireEvent.click(sourceButton);
  const inner = screen.getByRole('dialog', { name: 'Source settings' });
  const source = screen.getByRole('button', { name: 'Source' });
  const close = inner.querySelector('button[aria-label="Close"]');
  expect(document.activeElement).toBe(inner);

  fireEvent.mouseDown(outer.parentElement!);
  fireEvent.mouseDown(inner);
  expect(outer.isConnected && inner.isConnected).toBe(true);
  titleButton.focus();
  expect(document.activeElement).toBe(inner);
  fireEvent.keyDown(inner, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(source);
  fireEvent.keyDown(source, { key: 'Tab' });
  expect(document.activeElement).toBe(close);

  fireEvent.keyDown(close!, { key: 'Escape' });
  expect(inner.isConnected).toBe(false);
  expect(document.activeElement).toBe(sourceButton);
  expect(document.documentElement.classList.contains('nf-modal-open')).toBe(true);
  fireEvent.mouseDown(outer.parentElement!);
  expect(outer.isConnected).toBe(false);
  expect(document.activeElement).toBe(titleButton);
  expect(document.documentElement.classList.contains('nf-modal-open')).toBe(false);
});

it('gives a portalled dropdown the first Escape', () => {
  render(<NestedDialogs />);
  fireEvent.click(screen.getByRole('button', { name: 'Open title' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open source settings' }));
  const source = screen.getByRole('button', { name: 'Source' });
  source.focus();
  fireEvent.click(source);
  expect(screen.getByRole('listbox').parentElement).toBe(document.body);
  fireEvent.keyDown(source, { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(screen.getByRole('dialog', { name: 'Source settings' })).toBeTruthy();
  expect(document.activeElement).toBe(source);
  fireEvent.keyDown(source, { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: 'Source settings' })).toBeNull();
});

it('lets playback take focus while the library dialog is hidden', () => {
  const close = vi.fn();
  const view = render(<>
    <section style={{ visibility: 'visible' }}><CatalogDialog title="Title" onClose={close} active>Details</CatalogDialog></section>
    <button>Pause playback</button>
  </>);
  expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Title' }));
  view.rerender(<>
    <section style={{ visibility: 'hidden' }}><CatalogDialog title="Title" onClose={close} active>Details</CatalogDialog></section>
    <button>Pause playback</button>
  </>);
  const playback = screen.getByRole('button', { name: 'Pause playback' });
  playback.focus();
  expect(document.activeElement).toBe(playback);
  expect(fireEvent.keyDown(playback, { key: 'Tab' })).toBe(true);
  fireEvent.keyDown(playback, { key: 'Escape' });
  expect(close).not.toHaveBeenCalled();
});

it('refocuses Cancel when a destructive confirmation replaces another request', async () => {
  render(<><button>Launch action</button><ConfirmDialog /></>);
  const opener = screen.getByRole('button', { name: 'Launch action' });
  opener.focus();
  const confirm = useLibraryStore.getState().confirm;
  let first!: Promise<boolean>;
  let second!: Promise<boolean>;
  act(() => { first = confirm({ title: 'Continue?', message: 'Ready to continue.' }); });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'OK' }));
  act(() => { second = confirm({ title: 'Delete this title?', message: 'Remove it from the library.', danger: true }); });
  expect(await first).toBe(false);
  const cancel = screen.getByRole('button', { name: 'Cancel' });
  expect(document.activeElement).toBe(cancel);
  fireEvent.keyDown(cancel, { key: 'Escape' });
  expect(await second).toBe(false);
  expect(document.activeElement).toBe(opener);
});
