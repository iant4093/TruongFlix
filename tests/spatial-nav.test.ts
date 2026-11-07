import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EDGE_EVENT,
  arrowLeavesElement,
  configureSpatialNav,
  isInDirection,
  moveFocus,
  noteFocus,
  pickNearest,
  resetSpatialNav,
  type Box,
} from '../src/lib/spatialNav';

const box = (left: number, top: number, w = 100, h = 60): Box => ({ left, top, right: left + w, bottom: top + h });

function place(el: HTMLElement, left: number, top: number, w = 100, h = 60) {
  el.getBoundingClientRect = () => ({ left, top, right: left + w, bottom: top + h, width: w, height: h, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
  return el;
}

function button(parent: HTMLElement, label: string, left: number, top: number, w = 100, h = 60) {
  const b = document.createElement('button');
  b.textContent = label;
  parent.appendChild(b);
  return place(b, left, top, w, h);
}

/** Two rows of four cards plus a navbar link; rows are `data-nav-row`. */
function rows() {
  const nav = document.createElement('header');
  nav.setAttribute('data-nav-fixed', '');
  document.body.appendChild(nav);
  const home = button(nav, 'Home', 40, 20, 60, 30);
  const grid: HTMLButtonElement[][] = [];
  for (let r = 0; r < 2; r++) {
    const row = document.createElement('section');
    row.setAttribute('data-nav-row', '');
    document.body.appendChild(row);
    grid.push([0, 1, 2, 3].map((c) => button(row, `r${r}c${c}`, 40 + c * 110, 200 + r * 150) as HTMLButtonElement));
  }
  return { home, grid, rowEls: [...document.querySelectorAll<HTMLElement>('[data-nav-row]')] };
}

beforeEach(() => {
  document.body.innerHTML = '';
  resetSpatialNav();
  configureSpatialNav({ scope: () => null, closeHover: () => {} });
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('geometry', () => {
  it('only considers candidates past the origin in that direction', () => {
    const from = box(100, 100);
    expect(isInDirection(from, box(220, 100), 'right')).toBe(true);
    expect(isInDirection(from, box(0, 100), 'right')).toBe(false);
    expect(isInDirection(from, box(100, 200), 'down')).toBe(true);
    expect(isInDirection(from, box(100, 0), 'down')).toBe(false);
    expect(isInDirection(from, box(100, 0), 'up')).toBe(true);
  });

  it('prefers the aligned neighbour over a closer diagonal one', () => {
    const from = box(100, 100);
    const sameRow = { item: 'same', box: box(260, 100) };
    const diagonal = { item: 'diag', box: box(210, 180) };
    expect(pickNearest(from, [diagonal, sameRow], 'right')).toBe('same');
  });

  it('goes to the nearest row first, then the closest column', () => {
    const from = box(210, 100);
    const next = [0, 1, 2, 3].map((c) => ({ item: `n${c}`, box: box(c * 110, 250) }));
    const far = [{ item: 'far', box: box(210, 600) }];
    expect(pickNearest(from, [...far, ...next], 'down')).toBe('n2');
  });

  it('between rows, lands on the next row even when it is short', () => {
    const from = box(900, 100);
    const shortRow = [{ item: 'short', box: box(0, 250) }];
    const aligned = [{ item: 'aligned', box: box(900, 420) }];
    expect(pickNearest(from, [...shortRow, ...aligned], 'down', undefined, true)).toBe('short');
    // Outside rows (e.g. a settings page) the control in line wins over a nearer one far to the side.
    expect(pickNearest(from, [...shortRow, ...aligned], 'down')).toBe('aligned');
  });

  it('uses a remembered column instead of the origin position', () => {
    const from = box(0, 100, 600, 40); // a wide element (e.g. a billboard button bar)
    const next = [0, 1, 2, 3].map((c) => ({ item: `n${c}`, box: box(c * 110, 250) }));
    expect(pickNearest(from, next, 'down', 350)).toBe('n3');
  });
});

describe('DOM navigation', () => {
  it('moves along a row and down to the card below', () => {
    const { grid } = rows();
    grid[0][1].focus();
    expect(moveFocus('right')).toMatchObject({ moved: true });
    expect(document.activeElement).toBe(grid[0][2]);
    moveFocus('down');
    expect(document.activeElement).toBe(grid[1][2]);
    moveFocus('up');
    expect(document.activeElement).toBe(grid[0][2]);
    moveFocus('up');
    expect(document.activeElement?.textContent).toBe('Home');
  });

  it('remembers each row’s card when coming back to it', () => {
    const { grid } = rows();
    grid[1][3].focus();
    noteFocus(grid[1][3]);
    grid[0][0].focus();
    noteFocus(grid[0][0]);
    moveFocus('down');
    expect(document.activeElement).toBe(grid[1][3]);
  });

  it('keeps horizontal moves inside a row and asks the row to page at its edge', () => {
    const { grid, rowEls } = rows();
    const onEdge = vi.fn((e: Event) => e.preventDefault());
    rowEls[0].addEventListener(EDGE_EVENT, onEdge);
    grid[0][3].focus();
    expect(moveFocus('right')).toEqual({ moved: false, paged: true });
    expect(onEdge).toHaveBeenCalledTimes(1);
    expect((onEdge.mock.calls[0][0] as CustomEvent).detail.direction).toBe('right');
    expect(document.activeElement).toBe(grid[0][3]);
  });

  it('skips inert, disabled and skipped elements', () => {
    const { grid } = rows();
    grid[0][2].setAttribute('inert', '');
    grid[0][3].disabled = true;
    grid[0][1].focus();
    expect(moveFocus('right')).toMatchObject({ moved: false });
  });

  it('confines navigation to the top dialog layer', () => {
    const { grid } = rows();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.tabIndex = -1;
    document.body.appendChild(dialog);
    const a = button(dialog, 'Play', 300, 300);
    const b = button(dialog, 'My List', 420, 300);
    configureSpatialNav({ scope: () => dialog });
    dialog.focus();
    moveFocus('right');
    expect(document.activeElement).toBe(a);
    moveFocus('right');
    expect(document.activeElement).toBe(b);
    moveFocus('down');
    // Rows below the dialog are outside its layer.
    expect(document.activeElement).toBe(b);
    expect(grid[1].includes(document.activeElement as HTMLButtonElement)).toBe(false);
  });

  it('steps into an open hover card with Down and back with Up', () => {
    const { grid } = rows();
    const card = document.createElement('div');
    card.setAttribute('data-hover-card', '');
    document.body.appendChild(card);
    place(card, 150, 180, 140, 160);
    const play = button(card, 'Play', 160, 300, 36, 36);
    const more = button(card, 'More info', 240, 300, 36, 36);
    const closeHover = vi.fn();
    configureSpatialNav({ closeHover });
    grid[0][1].focus();
    moveFocus('down');
    expect(document.activeElement).toBe(play);
    moveFocus('right');
    expect(document.activeElement).toBe(more);
    moveFocus('up');
    expect(document.activeElement).toBe(grid[0][1]);
    moveFocus('right');
    expect(closeHover).toHaveBeenCalled();
  });

  it('lets text fields keep arrows until the caret reaches an edge', () => {
    const input = document.createElement('input');
    input.value = 'abc';
    document.body.appendChild(input);
    input.setSelectionRange(1, 1);
    expect(arrowLeavesElement(input, 'left')).toBe(false);
    expect(arrowLeavesElement(input, 'down')).toBe(true);
    input.setSelectionRange(3, 3);
    expect(arrowLeavesElement(input, 'right')).toBe(true);
    input.setSelectionRange(0, 0);
    expect(arrowLeavesElement(input, 'left')).toBe(true);
    const range = document.createElement('input');
    range.type = 'range';
    expect(arrowLeavesElement(range, 'left')).toBe(false);
  });

  it('enters a tab list on its current tab', () => {
    const { grid } = rows();
    const nav = document.createElement('nav');
    nav.setAttribute('data-nav-tabs', '');
    document.querySelector('header')!.appendChild(nav);
    button(nav, 'TV Shows', 270, 20, 60, 30);
    const movies = button(nav, 'Movies', 340, 20, 60, 30);
    movies.setAttribute('aria-current', 'page');
    grid[0][2].focus();
    moveFocus('up');
    expect(document.activeElement).toBe(movies);
  });

  it('focuses the preferred element when nothing is focused', () => {
    const { grid } = rows();
    grid[1][2].setAttribute('data-nav-autofocus', '');
    moveFocus('down', null);
    expect(document.activeElement).toBe(grid[1][2]);
  });
});
