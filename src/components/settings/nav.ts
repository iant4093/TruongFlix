import { useLibraryStore } from '../../store/useLibraryStore';

/** Closes Settings, then opens something else (a tool, the profile screen…). */
export function closeSettingsAnd(fn: () => void) {
  useLibraryStore.getState().setSettingsOpen(false);
  fn();
}
