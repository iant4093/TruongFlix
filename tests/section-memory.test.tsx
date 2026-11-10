import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { forgetSection, SectionMemory } from '../src/lib/sectionMemory';

const savedPosition = 900;
const page = () => document.scrollingElement ?? document.documentElement;
let available: number;
const frames = new Map<number, FrameRequestCallback>();

beforeEach(() => {
  forgetSection();
  frames.clear();
  available = 1200;
  let nextFrame = 0;
  vi.spyOn(page(), 'scrollHeight', 'get').mockImplementation(() => window.innerHeight + available);
  vi.stubGlobal('scrollY', 0);
  vi.stubGlobal('scrollTo', vi.fn(({ top }: ScrollToOptions) => vi.stubGlobal('scrollY', Math.min(top ?? 0, available))));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function seedSection() {
  const view = render(<SectionMemory section="browse">Browse</SectionMemory>);
  window.scrollTo({ top: savedPosition });
  window.dispatchEvent(new Event('scroll'));
  view.unmount();
  vi.mocked(window.scrollTo).mockClear();
}

function runFrame() {
  const callbacks = [...frames.values()];
  frames.clear();
  for (const callback of callbacks) callback(performance.now());
}

it('places a ready section immediately, without animating during its entry fade', () => {
  seedSection();
  render(<SectionMemory section="browse">Browse</SectionMemory>);

  expect(window.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: savedPosition, behavior: 'instant' });
  expect(frames.size).toBe(0);
});

it('animates towards the remembered position as a delayed section gains scrollable content', () => {
  seedSection();
  available = 100;
  render(<SectionMemory section="browse">Browse</SectionMemory>);
  vi.mocked(window.scrollTo).mockClear();

  available = 400;
  runFrame();
  runFrame();
  expect(window.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 400, behavior: 'smooth' });

  available = 1000;
  runFrame();
  expect(window.scrollTo).toHaveBeenCalledTimes(2);
  expect(window.scrollTo).toHaveBeenLastCalledWith({ top: savedPosition, behavior: 'smooth' });
  expect(frames.size).toBe(0);
});

it.each(['user input', 'section exit'])('cancels a delayed restoration on %s', (reason) => {
  seedSection();
  available = 100;
  const view = render(<SectionMemory section="browse">Browse</SectionMemory>);
  vi.mocked(window.scrollTo).mockClear();

  if (reason === 'user input') window.dispatchEvent(new Event('wheel'));
  else view.rerender(<SectionMemory section="browse" active={false}>Browse</SectionMemory>);
  available = 1000;
  runFrame();

  expect(window.scrollTo).not.toHaveBeenCalled();
  expect(frames.size).toBe(0);
});

it('stops an in-flight restore when the section leaves', () => {
  seedSection();
  available = 100;
  const view = render(<SectionMemory section="browse">Browse</SectionMemory>);
  // A native smooth scroll changes scrollY over several frames.
  vi.mocked(window.scrollTo).mockImplementationOnce(() => {});
  available = 1000;
  runFrame();
  expect(window.scrollTo).toHaveBeenLastCalledWith({ top: savedPosition, behavior: 'smooth' });

  view.rerender(<SectionMemory section="browse" active={false}>Browse</SectionMemory>);

  expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 100, behavior: 'instant' });
  expect(frames.size).toBe(0);
});
