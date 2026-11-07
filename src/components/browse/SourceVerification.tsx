import { useRef } from 'react';
import useSourcePane from '../../hooks/useSourcePane';
import { ShieldCheck } from 'lucide-react';

export default function SourceVerification({ requestId }: { requestId: string }) {
  const slot = useRef<HTMLDivElement>(null);
  const { error, retry } = useSourcePane(slot, requestId, true);
  return <section aria-label="Source verification" className="mt-5 overflow-hidden rounded-lg border border-white/15 bg-[#111]">
    <div className="flex items-center gap-3 border-b border-white/10 px-5 py-4"><ShieldCheck className="h-5 w-5 shrink-0 text-nf-red" /><div><h3 className="text-sm font-semibold">Verify to continue</h3><p className="mt-1 text-xs text-white/50">Complete your source’s verification here. The search resumes automatically.</p></div></div>
    {error && <p role="alert" className="px-5 py-3 text-sm text-red-300">{error}<button onClick={retry} className="ml-3 underline">Retry verification</button></p>}
    <div ref={slot} className="h-[360px] w-full bg-nf-surface" />
  </section>;
}
