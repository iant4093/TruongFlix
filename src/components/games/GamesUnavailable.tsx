import { Gamepad2 } from 'lucide-react';

/** Shown instead of Games on platforms without it (the Games code isn't part of those builds). */
export default function GamesUnavailable() {
  return <div className="flex min-h-[70vh] flex-col items-center justify-center px-[4%] pt-24 text-center">
    <Gamepad2 aria-hidden="true" className="mb-5 h-14 w-14 text-white/40" />
    <h1 className="text-3xl font-bold">Games is available on Windows</h1>
    <p className="mt-4 max-w-md text-sm leading-relaxed text-white/60">
      Installing and playing PC games needs Windows. Open TruongFlix on a Windows PC to browse, download and install games.
    </p>
  </div>;
}
