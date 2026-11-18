// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverHasNewVersion } from '../src/remote/updateCheck';

const page = (script: string) => `<!doctype html><html><head><script type="module" crossorigin src="${script}"></script></head><body></body></html>`;

describe('browser app update check', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.head.innerHTML = '';
  });

  it('sees a new build on the PC', async () => {
    document.head.innerHTML = '<script type="module" src="/assets/remote-old.js"></script>';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(page('/assets/remote-new.js'))));
    expect(await serverHasNewVersion()).toBe(true);
  });

  it('stays put on the same build', async () => {
    document.head.innerHTML = '<script type="module" src="/assets/remote-same.js"></script>';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(page('/assets/remote-same.js'))));
    expect(await serverHasNewVersion()).toBe(false);
  });
});
