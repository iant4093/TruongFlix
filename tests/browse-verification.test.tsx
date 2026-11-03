import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import SourceVerification from '../src/components/browse/SourceVerification';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(invoke).mockResolvedValue(undefined);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { queueMicrotask(() => callback(0)); return 1; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 40, y: -20, left: 40, top: -20, right: 740, bottom: 400, width: 700, height: 420, toJSON: () => ({}),
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('clips the native verification view away from the close control and hides it on unmount', async () => {
  const view = render(<SourceVerification requestId="request-fixture" />);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('source_browser_place', { requestId: 'request-fixture', rect: {
    x: 40, y: 64, width: 700, height: 336, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
  } }));
  view.unmount();
  expect(invoke).toHaveBeenLastCalledWith('source_browser_place', { requestId: 'request-fixture', rect: null });
});
it('offers a retry if the native panel cannot be displayed', async () => {
  vi.mocked(invoke).mockRejectedValueOnce(new Error('Native view unavailable'));
  render(<SourceVerification requestId="request-fixture" />);
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Retry verification' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  const shown = vi.mocked(invoke).mock.calls.filter(([, args]) => (args as { rect: unknown }).rect != null);
  expect(shown).toHaveLength(2);
});
