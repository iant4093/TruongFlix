/** A game as listed by the source (rows, search results). */
export interface GameCard {
  /** Post slug on the source; stable id for a game. */
  slug: string;
  title: string;
  /** Edition/version text shown under the title, e.g. "v1.9.0.37 + 4 DLCs". */
  subtitle: string;
  cover: string | null;
  postId: number | null;
  date: string | null;
}

/** Full details parsed from a source post. */
export interface GameDetail extends GameCard {
  link: string;
  genres: string[];
  companies: string[];
  languages: string;
  originalSize: string;
  repackSize: string;
  /** True when the repack offers optional files (selective download). */
  selective: boolean;
  magnet: string | null;
  screenshots: { thumb: string; full: string }[];
  features: string[];
  description: string;
}

export interface GameRow {
  title: string;
  games: GameCard[];
}

// ---------------------------------------------------------------------------
// Installer options (from the Rust `games_inspect_installer` command)
// ---------------------------------------------------------------------------

export interface InstallerLanguage { name: string; display: string }
export interface InstallerType { name: string; description: string; languages: string | null; isCustom: boolean }
export interface InstallerComponent {
  name: string;
  description: string;
  types: string | null;
  languages: string | null;
  level: number;
  size: number;
  fixed: boolean;
  exclusive: boolean;
  dontInheritCheck: boolean;
}
export interface InstallerTask {
  name: string;
  description: string;
  groupDescription: string | null;
  components: string | null;
  languages: string | null;
  level: number;
  unchecked: boolean;
  exclusive: boolean;
  dontInheritCheck: boolean;
}
export interface InstallerRunEntry {
  filename: string;
  parameters: string;
  workingDir: string | null;
  description: string;
  postInstall: boolean;
  unchecked: boolean;
  skipIfSilent: boolean;
  shellExec: boolean;
  components: string | null;
  tasks: string | null;
  languages: string | null;
}
export interface InstallerIcon {
  name: string;
  filename: string;
  components: string | null;
  tasks: string | null;
  languages: string | null;
}
export interface InstallerMessage { name: string; value: string; language: string | null }

export interface InstallerInfo {
  setupExe: string;
  appName: string;
  defaultDirName: string;
  extraDiskSpace: number;
  languages: InstallerLanguage[];
  types: InstallerType[];
  components: InstallerComponent[];
  tasks: InstallerTask[];
  runEntries: InstallerRunEntry[];
  icons: InstallerIcon[];
  messages: InstallerMessage[];
}

export interface KnownFolders {
  commonDesktop: string;
  userDesktop: string;
  commonPrograms: string;
  userPrograms: string;
}

/** One option row shown in the install dialog, already filtered to the chosen language. */
export interface ComponentOption {
  name: string;
  label: string;
  level: number;
  size: number;
  fixed: boolean;
  exclusive: boolean;
  /** System redistributable (DirectX, Visual C++, …): unchecked by default. */
  redist: boolean;
  /** Optional content whose files were not downloaded; can't be installed. */
  unavailable: boolean;
}

export interface TaskOption {
  name: string;
  label: string;
  group: string | null;
  level: number;
  exclusive: boolean;
  components: string | null;
}

/** An after-install action from the installer's final page. */
export interface AfterInstallOption {
  id: string;
  label: string;
  filename: string;
  parameters: string;
  workingDir: string | null;
  components: string | null;
  tasks: string | null;
  redist: boolean;
}

export interface InstallChoices {
  language: string | null;
  installDir: string;
  components: string[];
  tasks: string[];
  startMenu: boolean;
  desktopShortcut: boolean;
  /** "Limit installer to 2 GB of RAM" when the installer offers it; null otherwise. */
  limitRam: boolean | null;
  afterInstall: string[];
}

/** Payload for the Rust `games_install` command (mirrors `helper::InstallJob`). */
export interface InstallJobPayload {
  setupExe: string;
  installDir: string;
  language: string | null;
  components: string[] | null;
  tasks: string[] | null;
  noIcons: boolean;
  limitRam: boolean | null;
  removeShortcuts: string[];
  postActions: { label: string; filename: string; parameters: string; workingDir: string | null }[];
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

export type GameStatus =
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'verifying'
  | 'installed'
  | 'install_failed'
  | 'verify_failed'
  | 'uninstalling';

export interface LibraryGame {
  id: number;
  slug: string;
  title: string;
  subtitle: string;
  cover: string | null;
  /** Full source details captured when the game was added. */
  detail: GameDetail | null;
  status: GameStatus;
  infoHash: string | null;
  /** Folder holding the downloaded installer (setup.exe + .bin files). */
  installerDir: string | null;
  installDir: string | null;
  exePath: string | null;
  autoInstall: boolean;
  deleteInstaller: boolean;
  /** Choices made up front (auto-install) or last used. */
  choices: InstallChoices | null;
  error: string | null;
  sizeBytes: number | null;
  playSeconds: number;
  lastPlayed: string | null;
  installedAt: string | null;
  createdAt: string;
}

export interface GameSettings {
  sourceUrl: string;
  downloadDir: string;
  installDir: string;
  autoInstall: boolean;
  deleteInstaller: boolean;
  installRedists: boolean;
  desktopShortcut: boolean;
}
