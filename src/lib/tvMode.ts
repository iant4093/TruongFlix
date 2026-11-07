import { create } from 'zustand';

export type TvModeSetting = 'auto' | 'on' | 'off';

interface TvModeState {
  setting: TvModeSetting;
  /** Auto mode switched on by a controller or arrow-key navigation (until the mouse is used). */
  engaged: boolean;
  /** Last input was arrows/D-pad: show the TV focus ring. */
  keyboard: boolean;
  controller: boolean;
}

export const useTvMode = create<TvModeState>(() => ({ setting: 'auto', engaged: false, keyboard: false, controller: false }));

export const isTvActive = (s: Pick<TvModeState, 'setting' | 'engaged'>) => s.setting === 'on' || (s.setting === 'auto' && s.engaged);

/** True while TV mode's larger 10-foot layout is on. */
export function useTvActive() {
  return useTvMode(isTvActive);
}

export const parseTvMode = (raw: string | undefined): TvModeSetting => (raw === 'on' || raw === 'off' ? raw : 'auto');
