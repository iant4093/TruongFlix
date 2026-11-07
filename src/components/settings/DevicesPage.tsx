import { useCallback, useEffect, useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import { open as openExternal } from '@tauri-apps/plugin-shell';
import { Cast, Copy, ExternalLink, Loader2, LogOut, RefreshCw, ShieldAlert, Tv } from 'lucide-react';
import { useLibraryStore } from '../../store/useLibraryStore';
import { applyRemoteAccess } from '../../services/remoteapi';
import { discoverDevices, type CastDevice } from '../../services/cast';
import { detectStreamEncoder, encoderLabel } from '../../services/streaming';
import {
  remoteSessions, signOutRemote, TAILSCALE_DOWNLOAD, tailscaleServe, tailscaleStatus,
  type RemoteSession, type TailscaleStatus,
} from '../../services/tailscale';
import { Block, BTN, BTN_PRIMARY, Group, INPUT, Page, Row, StatusText, Switch, ToggleRow } from './ui';

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
  const [info, setInfo] = useState<{ port: number; addresses: string[]; login_paused?: boolean } | null>(null);
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
        footer="Works on your home network, and away from home through Tailscale. Connections from the internet are always refused. Anyone you give the code to can watch; profiles with a PIN still ask for it, and kids’ ratings and limits still apply. Five wrong codes block a device for 15 minutes, and twenty in an hour pause sign-in until you make a new code."
      >
        <ToggleRow
          label="Browser access"
          description="Open your library in Safari, Chrome or any browser on the same network. Files your browser can’t play are converted on the fly."
          checked={settings.remote_access}
          onChange={(v) => void updateSettings({ remote_access: v })}
        />
        {settings.remote_access && (
          <>
            {info?.login_paused && (
              <Block className="flex items-start gap-3 border border-red-500/30 bg-red-500/10">
                <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-red-300" />
                <p className="text-sm text-red-100">Browser sign-in is paused because of too many wrong codes. Make a new code below to turn it back on — everyone already signed in stays signed out until they enter it.</p>
              </Block>
            )}
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
      {settings.remote_access && info && <SignedInBrowsers />}
      {settings.remote_access && info && <AwayFromHome port={info.port} />}
      <CastDevices />
    </Page>
  );
}

function ago(ms: number) {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return new Date(ms).toLocaleDateString();
}

function SignedInBrowsers() {
  const [sessions, setSessions] = useState<RemoteSession[] | null>(null);
  const refresh = useCallback(() => void remoteSessions().then(setSessions).catch(() => setSessions([])), []);
  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  const signOut = async (id: string | null) => {
    await signOutRemote(id);
    refresh();
  };
  return (
    <Group title="Signed-in browsers" footer="Browsers stay signed in for up to 14 days unused (60 days at most). Signing a browser out stops anything it’s playing.">
      {sessions == null ? (
        <Row label="Loading…" />
      ) : sessions.length === 0 ? (
        <Row label="No browsers are signed in" />
      ) : (
        <>
          {sessions.map((s) => (
            <Row key={s.id} label={s.device} description={`${s.ip} · last used ${ago(s.lastSeenMs)} · signed in ${new Date(s.signedInMs).toLocaleDateString()}`}>
              <button onClick={() => void signOut(s.id)} className={BTN}>
                <LogOut className="h-4 w-4" /> Sign out
              </button>
            </Row>
          ))}
          {sessions.length > 1 && (
            <Row label="Sign out every browser">
              <button onClick={() => void signOut(null)} className={BTN}>
                <LogOut className="h-4 w-4" /> Sign out all
              </button>
            </Row>
          )}
        </>
      )}
    </Group>
  );
}

function AwayFromHome({ port }: { port: number }) {
  const toast = useLibraryStore((s) => s.toast);
  const [status, setStatus] = useState<TailscaleStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [approval, setApproval] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setStatus(await tailscaleStatus(port).catch(() => null));
  }, [port]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggleServe = async (enable: boolean) => {
    setBusy(true);
    setError('');
    try {
      const res = await tailscaleServe(enable, port);
      setStatus(res.status);
      setApproval(res.approvalUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const running = status?.state === 'Running';
  const plainUrl = running && status?.ipv4 ? `http://${status.ipv4}:${port}` : null;
  const httpsUrl = running && status?.serving && status.dnsName ? `https://${status.dnsName}` : null;
  const shown = httpsUrl ?? plainUrl;
  const copy = (url: string) => void navigator.clipboard.writeText(url).then(() => toast('Address copied', 'success'));

  return (
    <Group
      title="Away from home"
      footer="Uses Tailscale, a free private network between your own devices. Only devices signed in to your Tailscale account can reach TruongFlix — nothing is opened to the public internet, and the access code is still required."
    >
      {status == null ? (
        <Row label="Checking for Tailscale…" />
      ) : !status.installed ? (
        <Block className="space-y-3">
          <p className="text-sm text-nf-secondary">To watch away from home:</p>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-nf-secondary">
            <li>Install Tailscale on this computer and sign in.</li>
            <li>Install Tailscale on your phone or tablet and sign in with the same account.</li>
            <li>Come back here for your away-from-home address.</li>
          </ol>
          <div className="flex gap-2">
            <button onClick={() => void openExternal(TAILSCALE_DOWNLOAD)} className={BTN_PRIMARY}>
              <ExternalLink className="h-4 w-4" /> Get Tailscale
            </button>
            <button onClick={() => void refresh()} className={BTN}>
              <RefreshCw className="h-4 w-4" /> Check again
            </button>
          </div>
        </Block>
      ) : !running ? (
        <Row label="Tailscale isn’t connected" description="Open Tailscale on this computer and sign in, then check again.">
          <button onClick={() => void refresh()} className={BTN}>
            <RefreshCw className="h-4 w-4" /> Check again
          </button>
        </Row>
      ) : (
        <>
          {status.funnel && (
            <Block className="flex items-start gap-3 border border-red-500/30 bg-red-500/10">
              <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-red-300" />
              <p className="text-sm text-red-100">Tailscale Funnel is publishing this computer’s address to the whole internet. Turn Funnel off in Tailscale to keep TruongFlix private.</p>
            </Block>
          )}
          {shown && (
            <Block className="flex items-center gap-5">
              <Qr text={shown} />
              <div className="min-w-0 space-y-3">
                <div>
                  <div className="text-xs uppercase tracking-widest text-nf-muted">Away-from-home address</div>
                  <button onClick={() => copy(shown)} className={`selectable flex items-center gap-2 break-all text-left font-mono hover:underline ${shown.length > 24 ? 'text-sm' : 'text-lg'}`} title="Copy">
                    {shown} <Copy className="h-4 w-4 shrink-0 text-nf-muted" />
                  </button>
                </div>
                <p className="text-xs text-nf-muted">Open it on a phone, tablet or computer that’s signed in to your Tailscale account, then enter the access code.</p>
              </div>
            </Block>
          )}
          <Row
            label="Secure HTTPS address"
            description={
              error ? <StatusText tone="bad">{error}</StatusText>
                : status.portInUse ? 'Tailscale Serve already shares something else at this address, so TruongFlix leaves it alone.'
                  : `Adds https://${status.dnsName ?? 'this-computer.ts.net'} with Tailscale Serve. Still private to your Tailscale devices.`
            }
          >
            {busy ? <Loader2 className="h-5 w-5 animate-spin text-nf-muted" /> : (
              <Switch checked={status.serving} onChange={(v) => void toggleServe(v)} label="Secure HTTPS address" />
            )}
          </Row>
          {approval && (
            <Row label="Allow HTTPS in your Tailscale account" description="Tailscale needs you to approve HTTPS once. Approve it in the page that opens, then turn the switch on again.">
              <button onClick={() => void openExternal(approval)} className={BTN_PRIMARY}>
                <ExternalLink className="h-4 w-4" /> Approve
              </button>
            </Row>
          )}
          <Row label="Tailscale" description={`Connected${status.dnsName ? ` as ${status.dnsName}` : ''}`}>
            <button onClick={() => void refresh()} className={BTN}>
              <RefreshCw className="h-4 w-4" /> Refresh
            </button>
          </Row>
        </>
      )}
    </Group>
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
