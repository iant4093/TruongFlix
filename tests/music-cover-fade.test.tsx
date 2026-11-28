import { describe, expect, it, beforeEach } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { addLayer, initialLayers, layerCovered, layerFailed, layerShown } from '../src/music/coverLayers';
import { Cover } from '../src/music/components/ui';
import { useMusicPlayer } from '../src/music/player';
import type { MusicApi } from '../src/music/api';

describe('cover layers', () => {
  it('keeps the old picture until the new one has loaded and faded in', () => {
    let layers = initialLayers('a.jpg');
    expect(layers).toEqual([{ src: 'a.jpg', shown: true }]);
    layers = addLayer(layers, 'b.jpg');
    expect(layers).toEqual([{ src: 'a.jpg', shown: true }, { src: 'b.jpg', shown: false }]);
    layers = layerShown(layers, 'b.jpg');
    expect(layers.map((l) => l.shown)).toEqual([true, true]);
    layers = layerCovered(layers, 'b.jpg');
    expect(layers).toEqual([{ src: 'b.jpg', shown: true }]);
  });

  it('drops pictures that never loaded when skipping on quickly', () => {
    let layers = addLayer(initialLayers('a.jpg'), 'b.jpg');
    layers = addLayer(layers, 'c.jpg');
    // b never showed: c fades in straight over a.
    expect(layers).toEqual([{ src: 'a.jpg', shown: true }, { src: 'c.jpg', shown: false }]);
    // Same album (same art): nothing changes.
    expect(addLayer(layers, 'c.jpg')).toBe(layers);
  });

  it('goes straight back to a picture still on screen', () => {
    const layers = layerShown(addLayer(initialLayers('a.jpg'), 'b.jpg'), 'b.jpg');
    expect(addLayer(layers, 'a.jpg')).toEqual([{ src: 'a.jpg', shown: true }]);
  });

  it('keeps at most two pictures under the one loading', () => {
    let layers = initialLayers('a.jpg');
    for (const src of ['b.jpg', 'c.jpg', 'd.jpg']) layers = layerShown(addLayer(layers, src), src);
    layers = addLayer(layers, 'e.jpg');
    expect(layers.map((l) => l.src)).toEqual(['c.jpg', 'd.jpg', 'e.jpg']);
  });

  it('shows the placeholder for no art and forgets failed pictures', () => {
    expect(addLayer(initialLayers('a.jpg'), null)).toEqual([]);
    expect(layerFailed(addLayer(initialLayers('a.jpg'), 'b.jpg'), 'b.jpg')).toEqual([{ src: 'a.jpg', shown: true }]);
  });
});

describe('<Cover>', () => {
  beforeEach(() => {
    useMusicPlayer.setState({ api: { artUrl: (art: string | null) => (art ? `art://${art}` : null) } as unknown as MusicApi });
  });

  const imgs = (c: HTMLElement) => [...c.querySelectorAll('img')].map((i) => ({ src: i.getAttribute('src'), visible: i.className.includes('opacity-100') }));

  it('never changes the src of a picture on screen, and shows the next one only once loaded', async () => {
    const { container, rerender } = render(<Cover art="a" />);
    expect(imgs(container)).toEqual([{ src: 'art://a', visible: true }]);
    const first = container.querySelector('img');

    rerender(<Cover art="b" />);
    // The old cover stays as it was; the new one waits, invisible, on top.
    expect(imgs(container)).toEqual([{ src: 'art://a', visible: true }, { src: 'art://b', visible: false }]);
    expect(container.querySelector('img')).toBe(first);

    const next = container.querySelectorAll('img')[1];
    await act(async () => {
      fireEvent.load(next);
    });
    expect(imgs(container)).toEqual([{ src: 'art://a', visible: true }, { src: 'art://b', visible: true }]);

    fireEvent.transitionEnd(next);
    expect(imgs(container)).toEqual([{ src: 'art://b', visible: true }]);
    // The faded-in picture is the same element: nothing reloads, nothing blinks.
    expect(container.querySelector('img')).toBe(next);
  });

  it('shows the placeholder, not the last song’s art, when the new art fails', () => {
    const { container, rerender } = render(<Cover art="a" />);
    rerender(<Cover art="b" />);
    fireEvent.error(container.querySelectorAll('img')[1]);
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelector('svg')).not.toBeNull();
  });
});
