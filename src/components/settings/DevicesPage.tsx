import { useEffect, useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import { Cast, Copy, Loader2, RefreshCw, Tv } from 'lucide-react';
import { useLibraryStore } from '../../store/useLibraryStore';
import { applyRemoteAccess } from '../../services/remoteapi';
import { discoverDevices, type CastDevice } from '../../services/cast';
import { detectStreamEncoder, encoderLabel } from '../../services/streaming';
import { Block, BTN, Group, INPUT, Page, Row, StatusText, ToggleRow } from './ui';

const IS_MAC = navigator.userAgent.includes('Mac');

function Qr({ text }: { text: string }) {
  const svg = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [text]);
  return <div className="h-36 w-36 shrink-0 overflow-hidden rounded-md bg-white p-1" dangerouslySetInnerHTML={{ __html: svg }} />;
}

export default function DevicesPage() {
  const settings = useLibraryStore((s) => s.settings);
  const updateSettings = useLibraryStore((s) => s.updateSettings);
  const toast = useLibraryStore((s) => s.toast);
  const [info, setInfo] = useState<{ port: number; addresses: string[] } | null>(null);
  const [error, setError] = useState('');
  const [port, setPort] = useState(String(settings.remote_port || 8732));
  const [encoder, setEncoder] = useState<string | null>(null);
  const [encoderErr, setEncoderErr] = useState('');

  const apply = async () => {
    setError('');
    try {
      setInfo(await applyRemoteAccess());
    } catch (e) {
      setError(String(e));
    }
  };
  useEffect(() => {
    void apply();
  }, [settings.remote_access, settings.remote_code, settings.remote_port]);
  useEffect(() => {
    let alive = true;
    detectStreamEncoder()
      .then((enc) => {
        if (alive) {
          setEncoder(enc);
          setEncoderErr('');
        }
      })
      .catch((e) => {
        if (alive) setEncoderErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  const url = info?.addresses[0] ? `http://${info.addresses[0]}:${info.port}` : null;

  return (
    <Page title="Devices" description="Watch on a phone, tablet or another computer at home, or cast to a TV.">
      <Group
        title="Watch in a browser"
        footer="Works on your home network only. Anyone with the code can watch, and profiles with a PIN still ask for it. Progress is shared with this computer."
      >
        <ToggleRow
          label="Browser access"
          description="Open your library in Safari, Chrome or any browser on the same network. Files your browser can’t play are converted on the fly."
          checked={settings.remote_access}
          onChange={(v) => void updateSettings({ remote_access: v })}
        />
        {settings.remote_access && (
          <>
            <Block className="flex items-center gap-5">
              {url ? <Qr text={url} /> : <div className="flex h-36 w-36 items-center justify-center rounded-md bg-white/5"><Loader2 className="h-6 w-6 animate-spin text-nf-muted" /></div>}
              <div className="min-w-0 space-y-3">
                <div>
                  <div className="text-xs uppercase tracking-widest text-nf-muted">Address</div>
                  {url ? (
                    <button
                      onClick={() => void navigator.clipboard.writeText(url).then(() => toast('Address copied', 'success'))}
                      className="selectable flex items-center gap-2 font-mono text-lg hover:underline"
                      title="Copy"
                    >
                      {url} <Copy className="h-4 w-4 text-nf-muted" />
                    </button>
                  ) : (
                    <StatusText>Finding this computer’s address…</StatusText>
                  )}
                </div>
                <div>
                  <div className="text-xs uppercase tracking-widest text-nf-muted">Access code</div>
                  <div className="font-mono text-3xl tracking-[0.3em]">{settings.remote_code || '······'}</div>
                </div>
                <p className="text-xs text-nf-muted">Scan the code with your phone’s camera, or type the address into a browser.</p>
              </div>
            </Block>
            <Row label="New access code" description="Signs out every browser that used the old code.">
              <button
                onClick={() => void updateSettings({ remote_code: String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000)) })}
                className={BTN}
              >
                <RefreshCw className="h-4 w-4" /> New code
              </button>
            </Row>
            <Row label="Port" description={error ? <StatusText tone="bad">{error}</StatusText> : 'Change it only if another app already uses this one.'}>
              <input
                value={port}
                onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
                onBlur={() => {
                  const n = Number(port);
                  if (n >= 1024 && n <= 65535 && n !== settings.remote_port) void updateSettings({ remote_port: n });
                  else setPort(String(settings.remote_port));
                }}
                className={`${INPUT} w-24 text-center font-mono`}
              />
            </Row>
          </>
        )}
        <Row
          label="Video conversion"
          description={encoderErr ? <StatusText tone="bad">{encoderErr}</StatusText> : 'Used when a browser or TV can’t play the original file as-is.'}
        >
          <span className="text-sm text-nf-secondary">{encoder ? encoderLabel(encoder) : encoderErr ? 'Unavailable' : 'Checking…'}</span>
        </Row>
      </Group>
      <CastDevices />
    </Page>
  );
}

function CastDevices() {
  const [devices, setDevices] = useState<CastDevice[] | null>(null);
  const [busy, setBusy] = useState(false);
  const search = async () => {
    setBusy(true);
    setDevices(await discoverDevices().catch(() => []));
    setBusy(false);
  };
  return (
    <Group
      title="Cast to a TV"
      footer={
        <>
          Use the cast button in the player or on a title page. Chromecasts get a converted stream when needed; smart TVs (DLNA) play the original file when they can.
          {IS_MAC && ' If macOS asks, allow TruongFlix to find devices on your local network.'}
        </>
      }
    >
      <Row label="TVs on your network" description={devices == null ? 'Search to see which TVs TruongFlix can find.' : devices.length ? `${devices.length} found` : 'None found. Make sure the TV or Chromecast is on and on the same network.'}>
        <button onClick={() => void search()} disabled={busy} className={BTN}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Search
        </button>
      </Row>
      {devices?.map((d) => (
        <Row
          key={d.id}
          label={
            <span className="flex items-center gap-2">
              {d.kind === 'chromecast' ? <Cast className="h-4 w-4 text-nf-secondary" /> : <Tv className="h-4 w-4 text-nf-secondary" />}
              {d.name}
            </span>
          }
          description={`${d.kind === 'chromecast' ? 'Chromecast' : 'Smart TV (DLNA)'}${d.model ? ` · ${d.model}` : ''} · ${d.host}`}
        />
      ))}
    </Group>
  );
}
