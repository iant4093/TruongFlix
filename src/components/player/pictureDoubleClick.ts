import { useRef } from 'react';
import type { MouseEvent } from 'react';

/** Controls, menus and panels: clicks on these are never the picture's. */
const CONTROLS = 'button, a, input, select, textarea, label, [role="button"], [role="slider"], [role="dialog"], [role="menu"], [role="menuitem"], [role="listbox"], [data-controls]';

/** Whether a click landed on the picture itself rather than on the player's controls. */
export const onPicture = (event: MouseEvent) => !(event.target instanceof Element && event.target.closest(CONTROLS));

/** Two clicks this close (ms) are a double-click. */
const DOUBLE_CLICK = 500;

/**
 * Double-clicking the picture (full screen, in the players). Only a double-click whose two clicks
 * both landed on the picture counts: clicking Back 10 s twice quickly, or a control and then the
 * picture, doesn't. Spread the handlers on the player's outer element.
 */
export function usePictureDoubleClick(onDouble: () => void) {
  // When the last clicks landed on the picture (any click elsewhere clears them). Seen while
  // capturing, so a control that stops its clicks from bubbling still counts as elsewhere.
  const clicks = useRef<number[]>([]);
  return {
    onClickCapture: (event: MouseEvent) => {
      clicks.current = onPicture(event) ? [...clicks.current.slice(-1), event.timeStamp] : [];
    },
    onDoubleClick: (event: MouseEvent) => {
      const [first, second] = clicks.current;
      if (!onPicture(event) || first === undefined || second === undefined || second - first > DOUBLE_CLICK) return;
      clicks.current = [];
      onDouble();
    },
  };
}
