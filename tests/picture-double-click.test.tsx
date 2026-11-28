import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { usePictureDoubleClick } from '../src/components/player/pictureDoubleClick';

afterEach(cleanup);

/** A player: the picture, and a control that stops its clicks bubbling (like the real ones). */
function Player({ onDouble }: { onDouble: () => void }) {
  const handlers = usePictureDoubleClick(onDouble);
  return (
    <div data-testid="picture" {...handlers}>
      <button aria-label="Back 10 seconds" onClick={(e) => e.stopPropagation()} />
      <div data-controls data-testid="bar" onClick={(e) => e.stopPropagation()} />
    </div>
  );
}

/** Two clicks then the browser's double-click, as a real double-click arrives. */
function doubleClick(first: Element, second: Element = first) {
  fireEvent.click(first, { detail: 1 });
  fireEvent.click(second, { detail: 2 });
  fireEvent.doubleClick(second);
}

it('double-clicking the picture toggles full screen', () => {
  const onDouble = vi.fn();
  render(<Player onDouble={onDouble} />);
  doubleClick(screen.getByTestId('picture'));
  expect(onDouble).toHaveBeenCalledTimes(1);
});

it('clicking a control twice quickly doesn’t', () => {
  const onDouble = vi.fn();
  render(<Player onDouble={onDouble} />);
  doubleClick(screen.getByLabelText('Back 10 seconds'));
  doubleClick(screen.getByTestId('bar'));
  expect(onDouble).not.toHaveBeenCalled();
});

it('a control and then the picture doesn’t either', () => {
  const onDouble = vi.fn();
  render(<Player onDouble={onDouble} />);
  doubleClick(screen.getByLabelText('Back 10 seconds'), screen.getByTestId('picture'));
  expect(onDouble).not.toHaveBeenCalled();
});
