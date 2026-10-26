import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useLibraryStore } from '../../store/useLibraryStore';
import { runScan } from '../../services/scanner';
import {
  FolderList,
  OpenSubtitlesFields,
  TmdbKeyField,
  VlcSetup,
  type SubtitleSettingsValue,
} from '../common/SetupControls';
import { Wordmark } from '../layout/Navbar';

const STEPS = ['welcome', 'tmdb', 'vlc', 'subtitles', 'folders'] as const;
type Step = (typeof STEPS)[number];

/** First-run setup: TMDB key → VLC check/install → media folders → first scan. */
export default function OnboardingModal() {
  const settings = useLibraryStore((s) => s.settings);
  const updateSettings = useLibraryStore((s) => s.updateSettings);
  const setOpen = useLibraryStore((s) => s.setOnboardingOpen);

  const [step, setStep] = useState<Step>('welcome');
  const [apiKey, setApiKey] = useState(settings.tmdb_api_key);
  const [keyOk, setKeyOk] = useState(!!settings.tmdb_api_key);
  const [vlcPath, setVlcPath] = useState(settings.vlc_executable_path);
  const [dirs, setDirs] = useState<string[]>(settings.media_directories);
  const [subs, setSubs] = useState<SubtitleSettingsValue>({
    apiKey: settings.opensubtitles_api_key,
    language: settings.subtitle_language,
    username: settings.opensubtitles_username,
    password: settings.opensubtitles_password,
  });
  const [saving, setSaving] = useState(false);

  const idx = STEPS.indexOf(step);
  const next = () => setStep(STEPS[Math.min(idx + 1, STEPS.length - 1)]);
  const back = () => setStep(STEPS[Math.max(idx - 1, 0)]);

  const finish = async () => {
    setSaving(true);
    await updateSettings({
      tmdb_api_key: apiKey.trim(),
      vlc_executable_path: vlcPath,
      media_directories: dirs,
      opensubtitles_api_key: subs.apiKey.trim(),
      subtitle_language: subs.language,
    });
    setSaving(false);
    setOpen(false);
    void runScan();
  };

  const canContinue = step === 'tmdb' ? keyOk && !!apiKey.trim() : step === 'folders' ? dirs.length > 0 : true;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[80] flex items-center justify-center overflow-y-auto bg-[#141414] p-6"
    >
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(229,9,20,0.22),transparent_60%),radial-gradient(ellipse_at_bottom_left,rgba(229,9,20,0.10),transparent_55%)]" />
      <div className="absolute left-[4%] top-6">
        <Wordmark className="text-[2.4rem]" />
      </div>

      <motion.div
        layout
        className="relative w-full max-w-[560px] rounded-lg border border-white/5 bg-black/75 px-12 py-11 shadow-2xl backdrop-blur"
      >
        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -24 }}
            transition={{ duration: 0.22 }}
          >
            {step === 'welcome' && (
              <div className="space-y-5 text-center">
                <h1 className="text-[2.6rem] font-black leading-tight">Your movies. Your shows. One screen.</h1>
                <p className="text-lg text-nf-secondary">
                  TruongFlix turns the video files on your drives into a beautiful streaming-style library — and plays
                  everything in VLC with full 4K, HDR and Dolby Vision support.
                </p>
                <button onClick={next} className="nf-btn-red mt-2 w-full py-3.5 text-xl">
                  Get Started <ChevronRight className="h-6 w-6" />
                </button>
              </div>
            )}

            {step === 'tmdb' && (
              <div className="space-y-5">
                <StepHeader n={1} title="Connect to TMDB" />
                <p className="text-nf-secondary">
                  TruongFlix uses The Movie Database to fetch posters, backdrops, title logos, cast and episode details.
                  Paste your free API key below.
                </p>
                <TmdbKeyField
                  value={apiKey}
                  onChange={(v) => {
                    setApiKey(v);
                    setKeyOk(false);
                  }}
                  onValidated={setKeyOk}
                />
              </div>
            )}

            {step === 'vlc' && (
              <div className="space-y-5">
                <StepHeader n={2} title="Set up playback" />
                <p className="text-nf-secondary">
                  TruongFlix plays everything in its built-in player. VLC is optional — it’s used as a fallback for
                  the rare file the built-in player can’t handle.
                </p>
                <VlcSetup value={vlcPath} onChange={setVlcPath} />
              </div>
            )}

            {step === 'subtitles' && (
              <div className="space-y-5">
                <StepHeader n={3} title="Subtitles" optional />
                <p className="text-nf-secondary">
                  Add an OpenSubtitles API key to search and download subtitles from any movie or episode page.
                  They load automatically when VLC starts. Don’t need subtitles? Skip this — you can add a key later
                  in Settings.
                </p>
                <OpenSubtitlesFields value={subs} onChange={(patch) => setSubs((s) => ({ ...s, ...patch }))} />
              </div>
            )}

            {step === 'folders' && (
              <div className="space-y-5">
                <StepHeader n={4} title="Choose your media folders" />
                <p className="text-nf-secondary">
                  Pick the folders that hold your movies and TV shows. Messy scene-release names are fine — TruongFlix
                  will figure them out.
                </p>
                <FolderList value={dirs} onChange={setDirs} />
              </div>
            )}
          </motion.div>
        </AnimatePresence>

        {step !== 'welcome' && (
          <div className="mt-9 flex items-center justify-between">
            <button onClick={back} className="flex items-center gap-1 text-sm text-nf-secondary hover:text-white">
              <ChevronLeft className="h-4 w-4" /> Back
            </button>
            <div className="flex items-center gap-1.5">
              {STEPS.slice(1).map((s) => (
                <span key={s} className={`h-1.5 rounded-full transition-all ${s === step ? 'w-6 bg-nf-red' : 'w-1.5 bg-white/25'}`} />
              ))}
            </div>
            {step === 'folders' ? (
              <button onClick={finish} disabled={!canContinue || saving} className="nf-btn-red">
                Build My Library
              </button>
            ) : (
              <button onClick={next} disabled={!canContinue} className="nf-btn-red">
                {(step === 'vlc' && !vlcPath) || (step === 'subtitles' && !subs.apiKey.trim()) ? 'Skip for now' : 'Next'}
              </button>
            )}
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}

function StepHeader({ n, title, optional }: { n: number; title: string; optional?: boolean }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-widest text-nf-muted">
        Step {n} of 4{optional ? ' · Optional' : ''}
      </div>
      <h2 className="mt-1 text-3xl font-bold">{title}</h2>
    </div>
  );
}
