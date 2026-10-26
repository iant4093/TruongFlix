import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Pencil, Plus } from 'lucide-react';
import type { Maturity, Profile } from '../../types/media';
import { useLibraryStore } from '../../store/useLibraryStore';
import * as db from '../../services/db';
import { MATURITY_LABEL } from '../../store/selectors';
import ProfileAvatar from '../common/ProfileAvatar';
import { Wordmark } from '../layout/Navbar';

const MATURITY_HINT: Record<Maturity, string> = {
  all: 'Every title in your library.',
  teen: 'Up to PG-13 and TV-14. Unrated titles are hidden.',
  kids: 'Only G, PG, TV-Y, TV-Y7, TV-G and TV-PG. Unrated titles are hidden.',
};

/** Netflix's "Who's watching?" screen, plus profile management. */
export default function ProfileGate() {
  const mode = useLibraryStore((s) => s.profileGate);
  return <AnimatePresence>{mode && <Gate key="gate" mode={mode} />}</AnimatePresence>;
}

function Gate({ mode }: { mode: 'select' | 'manage' }) {
  const profiles = useLibraryStore((s) => s.profiles);
  const active = useLibraryStore((s) => s.activeProfile);
  const switchProfile = useLibraryStore((s) => s.switchProfile);
  const setGate = useLibraryStore((s) => s.setProfileGate);
  const [editing, setEditing] = useState<Profile | 'new' | null>(null);
  const managing = mode === 'manage';

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 1.04 }}
      transition={{ duration: 0.3 }}
      className="fixed inset-0 z-[150] flex flex-col items-center justify-center bg-nf-bg"
    >
      <div className="absolute left-[4%] top-6">
        <Wordmark className="text-[2.2rem]" />
      </div>

      <AnimatePresence mode="wait">
        {editing ? (
          <ProfileEditor key="editor" profile={editing === 'new' ? null : editing} onDone={() => setEditing(null)} canDelete={profiles.length > 1} />
        ) : (
          <motion.div key="grid" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="flex flex-col items-center">
            <h1 className="mb-10 text-[clamp(2rem,3.5vw,3.5rem)] font-medium">{managing ? 'Manage Profiles:' : 'Who’s watching?'}</h1>
            <div className="flex flex-wrap justify-center gap-[2vw]">
              {profiles.map((p) => (
                <button
                  key={p.id}
                  onClick={() => (managing ? setEditing(p) : switchProfile(p.id))}
                  className="group flex w-[clamp(84px,10vw,160px)] flex-col items-center gap-3"
                >
                  <span className="relative">
                    <ProfileAvatar
                      color={p.color}
                      maturity={p.maturity}
                      size={150}
                      className="!h-[clamp(84px,10vw,150px)] !w-[clamp(84px,10vw,150px)] ring-white transition group-hover:ring-[3px]"
                    />
                    {managing && (
                      <span className="absolute inset-0 flex items-center justify-center rounded bg-black/55">
                        <Pencil className="h-8 w-8" />
                      </span>
                    )}
                  </span>
                  <span className="text-[clamp(0.9rem,1.2vw,1.25rem)] text-nf-muted transition group-hover:text-white">{p.name}</span>
                  {p.maturity !== 'all' && <span className="-mt-2 text-xs text-nf-muted">{MATURITY_LABEL[p.maturity]}</span>}
                </button>
              ))}
              {profiles.length < 6 && (
                <button onClick={() => setEditing('new')} className="group flex w-[clamp(84px,10vw,160px)] flex-col items-center gap-3">
                  <span className="flex h-[clamp(84px,10vw,150px)] w-[clamp(84px,10vw,150px)] items-center justify-center rounded text-nf-muted transition group-hover:bg-white/10 group-hover:text-white">
                    <Plus className="h-16 w-16" strokeWidth={1.5} />
                  </span>
                  <span className="text-[clamp(0.9rem,1.2vw,1.25rem)] text-nf-muted group-hover:text-white">Add Profile</span>
                </button>
              )}
            </div>
            <div className="mt-14 flex gap-3">
              {managing ? (
                <button onClick={() => setGate(active ? null : 'select')} className="bg-white px-8 py-2 text-lg font-semibold text-black hover:bg-nf-red hover:text-white">
                  Done
                </button>
              ) : (
                <button
                  onClick={() => setGate('manage')}
                  className="border border-nf-muted px-8 py-2 text-lg tracking-widest text-nf-muted hover:border-white hover:text-white"
                >
                  MANAGE PROFILES
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function ProfileEditor({ profile, onDone, canDelete }: { profile: Profile | null; onDone: () => void; canDelete: boolean }) {
  const profiles = useLibraryStore((s) => s.profiles);
  const loadProfiles = useLibraryStore((s) => s.loadProfiles);
  const active = useLibraryStore((s) => s.activeProfile);
  const switchProfile = useLibraryStore((s) => s.switchProfile);
  const reload = useLibraryStore((s) => s.reload);
  const confirm = useLibraryStore((s) => s.confirm);
  const [name, setName] = useState(profile?.name ?? '');
  const [color, setColor] = useState(profile?.color ?? db.nextProfileColor(profiles.map((p) => p.color)));
  const [maturity, setMaturity] = useState<Maturity>(profile?.maturity ?? 'all');

  const save = async () => {
    const clean = name.trim() || 'Profile';
    if (profile) await db.updateProfile(profile.id, clean, color, maturity);
    else await db.createProfile(clean, color, maturity);
    await loadProfiles();
    if (profile && profile.id === active?.id) await reload(); // maturity may have changed
    onDone();
  };

  const remove = async () => {
    if (!profile) return;
    const ok = await confirm({
      title: `Delete “${profile.name}”?`,
      message: 'This profile’s Continue Watching, My List and viewing history will be deleted. Your files are not touched.',
      confirmLabel: 'Delete Profile',
      danger: true,
    });
    if (!ok) return;
    await db.deleteProfile(profile.id);
    await loadProfiles();
    if (profile.id === active?.id) {
      const next = useLibraryStore.getState().profiles[0];
      if (next) await switchProfile(next.id);
      useLibraryStore.getState().setProfileGate('manage');
    }
    onDone();
  };

  return (
    <motion.div key="editor" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="w-[min(640px,90vw)]">
      <h1 className="text-5xl font-medium">{profile ? 'Edit Profile' : 'Add Profile'}</h1>
      <div className="mt-6 flex gap-6 border-y border-white/15 py-6">
        <ProfileAvatar color={color} maturity={maturity} size={120} />
        <div className="flex-1 space-y-5">
          <input
            autoFocus
            value={name}
            maxLength={24}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()}
            placeholder="Name"
            className="w-full bg-[#666] px-3 py-2 text-lg text-white outline-none placeholder:text-white/60"
          />
          <div>
            <div className="mb-2 text-sm text-nf-secondary">Colour</div>
            <div className="flex gap-2">
              {db.PROFILE_PALETTE.map((c) => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  aria-label={`Colour ${c}`}
                  className={`h-8 w-8 rounded transition ${c === color ? 'ring-2 ring-white ring-offset-2 ring-offset-nf-bg' : 'opacity-80 hover:opacity-100'}`}
                  style={{ background: c }}
                />
              ))}
            </div>
          </div>
          <div>
            <div className="mb-2 text-sm text-nf-secondary">Maturity rating</div>
            <div className="flex flex-wrap gap-2">
              {(['all', 'teen', 'kids'] as Maturity[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setMaturity(m)}
                  className={`rounded border px-3 py-1.5 text-sm ${m === maturity ? 'border-white bg-white text-black' : 'border-white/30 text-nf-secondary hover:text-white'}`}
                >
                  {MATURITY_LABEL[m]}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-nf-muted">{MATURITY_HINT[maturity]}</p>
          </div>
        </div>
      </div>
      <div className="mt-8 flex gap-3">
        <button onClick={save} className="bg-white px-8 py-2 text-lg font-semibold text-black hover:bg-nf-red hover:text-white">
          Save
        </button>
        <button onClick={onDone} className="border border-nf-muted px-8 py-2 text-lg text-nf-muted hover:border-white hover:text-white">
          Cancel
        </button>
        {profile && canDelete && (
          <button onClick={remove} className="ml-auto border border-nf-muted px-6 py-2 text-lg text-nf-muted hover:border-nf-red hover:text-nf-red">
            Delete Profile
          </button>
        )}
      </div>
    </motion.div>
  );
}
