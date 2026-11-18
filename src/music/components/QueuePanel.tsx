import { ArrowDown, ArrowUp, GripVertical, Repeat, Repeat1, Shuffle, X } from 'lucide-react';
import { clearQueue, cycleRepeat, jumpTo, moveInQueue, removeFromQueue, toggleShuffle, useMusicPlayer } from '../player';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Cover } from './ui';

/** Playing Next: reorder (drag, or the arrows on touch screens), remove, clear, shuffle and repeat. */
export default function QueuePanel({ className = '' }: { className?: string }) {
  const queue = useMusicPlayer((s) => s.queue);
  const byId = useMusicPlayer((s) => s.byId);
  const next = queue.items.map((item, index) => ({ item, index })).slice(queue.index + 1);
  const reduce = useReducedMotion() ?? false;
  return (
    <div className={`flex min-h-0 flex-col ${className}`}>
      <div className="flex items-center gap-2 px-5 pb-3 pt-1">
        <h2 className="flex-1 text-lg font-bold">Playing Next</h2>
        <button
          type="button"
          onClick={toggleShuffle}
          aria-pressed={queue.shuffle}
          aria-label="Shuffle"
          title="Shuffle"
          className={`flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-semibold transition ${queue.shuffle ? 'bg-white text-black' : 'bg-white/10 text-white/80 hover:bg-white/15'}`}
        >
          <Shuffle className="h-3.5 w-3.5" /> Shuffle
        </button>
        <button
          type="button"
          onClick={cycleRepeat}
          aria-pressed={queue.repeat !== 'off'}
          aria-label={`Repeat: ${queue.repeat}`}
          title={queue.repeat === 'one' ? 'Repeat one' : queue.repeat === 'all' ? 'Repeat all' : 'Repeat off'}
          className={`flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-semibold transition ${queue.repeat !== 'off' ? 'bg-white text-black' : 'bg-white/10 text-white/80 hover:bg-white/15'}`}
        >
          {queue.repeat === 'one' ? <Repeat1 className="h-3.5 w-3.5" /> : <Repeat className="h-3.5 w-3.5" />} Repeat
        </button>
      </div>
      {next.length > 0 && (
        <div className="flex items-center justify-between px-5 pb-1 text-xs text-white/50">
          <span>{queue.repeat === 'all' ? 'Repeats when the queue ends' : `${next.length} song${next.length === 1 ? '' : 's'}`}</span>
          <button type="button" onClick={clearQueue} className="font-semibold text-white/70 hover:text-white">
            Clear
          </button>
        </div>
      )}
      <div className="tfm-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-6">
        {!next.length && <p className="px-2 py-8 text-center text-sm text-white/50">Nothing else is queued.</p>}
        {/* Moved songs glide to their new place; removed ones fold away. */}
        <AnimatePresence initial={false}>
        {next.map(({ item, index }, n) => {
          const t = byId.get(item.id);
          if (!t) return null;
          return (
            <motion.div
              key={item.key}
              layout={reduce ? false : 'position'}
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: reduce ? 0 : 0.25, layout: { type: 'spring', stiffness: 420, damping: 38 } }}
              className="overflow-hidden"
            >
            <div
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('text/x-tf-queue', String(index));
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => e.dataTransfer.types.includes('text/x-tf-queue') && e.preventDefault()}
              onDrop={(e) => {
                const from = Number(e.dataTransfer.getData('text/x-tf-queue'));
                if (Number.isFinite(from)) moveInQueue(from, index);
              }}
              className="group flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-white/[0.08]"
            >
              <GripVertical className="hidden h-4 w-4 shrink-0 cursor-grab text-white/30 sm:block" aria-hidden />
              <button type="button" onClick={() => jumpTo(index)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                <Cover art={t.art} className="h-10 w-10 shrink-0" rounded="rounded" />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{t.title}</div>
                  <div className="truncate text-xs text-white/55">{t.artist}</div>
                </div>
              </button>
              <div className="flex shrink-0 items-center opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                <button type="button" aria-label={`Move ${t.title} up`} disabled={n === 0} onClick={() => moveInQueue(index, index - 1)} className="flex h-8 w-8 items-center justify-center rounded-full text-white/60 hover:bg-white/10 disabled:opacity-30">
                  <ArrowUp className="h-4 w-4" />
                </button>
                <button type="button" aria-label={`Move ${t.title} down`} disabled={n === next.length - 1} onClick={() => moveInQueue(index, index + 1)} className="flex h-8 w-8 items-center justify-center rounded-full text-white/60 hover:bg-white/10 disabled:opacity-30">
                  <ArrowDown className="h-4 w-4" />
                </button>
                <button type="button" aria-label={`Remove ${t.title} from the queue`} onClick={() => removeFromQueue(index)} className="flex h-8 w-8 items-center justify-center rounded-full text-white/60 hover:bg-white/10">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            </motion.div>
          );
        })}
        </AnimatePresence>
      </div>
    </div>
  );
}
