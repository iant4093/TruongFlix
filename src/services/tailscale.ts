import { invoke } from '@tauri-apps/api/core';

export interface TailscaleStatus {
  installed: boolean;
  /** "Running", "NeedsLogin", "Stopped", "Starting", "NoState" or "". */
  state: string;
  ipv4: string | null;
  dnsName: string | null;
  httpsEnabled: boolean;
  /** Tailscale Serve forwards https://<dnsName> to TruongFlix. */
  serving: boolean;
  /** Serve already shares something else at that address. */
  portInUse: boolean;
  /** That address is published to the whole internet with Funnel. */
  funnel: boolean;
}

export interface RemoteSession {
  id: string;
  device: string;
  ip: string;
  signedInMs: number;
  lastSeenMs: number;
}

export const TAILSCALE_DOWNLOAD = 'https://tailscale.com/download';

export const tailscaleStatus = (port: number) => invoke<TailscaleStatus>('tailscale_status', { port });

/** Turns the private https address on or off; returns an approval link if the account owner must allow HTTPS first. */
export const tailscaleServe = (enable: boolean, port: number) =>
  invoke<{ status: TailscaleStatus; approvalUrl: string | null }>('tailscale_serve', { enable, port });

export const remoteSessions = () => invoke<RemoteSession[]>('remote_sessions');
export const signOutRemote = (id: string | null) => invoke('remote_session_revoke', { id });
