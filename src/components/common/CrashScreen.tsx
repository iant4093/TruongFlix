import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Catches a rendering error anywhere in the app. Without it, one bad title or setting left a blank
 * black window with no way back short of quitting.
 */
export default class CrashScreen extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[app] render crashed', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-nf-bg p-10 text-center text-white">
        <h1 className="text-3xl font-semibold">Something went wrong</h1>
        <p className="max-w-lg text-nf-secondary">TruongFlix ran into a problem showing this screen. Your library and watch history are safe.</p>
        <div className="flex gap-3">
          <button type="button" autoFocus onClick={() => window.location.reload()} className="nf-btn-red px-6 py-2 font-semibold">
            Reload TruongFlix
          </button>
          <button type="button" onClick={() => this.setState({ error: null })} className="nf-btn-ghost px-6 py-2">
            Try again
          </button>
        </div>
        <pre className="selectable max-w-2xl whitespace-pre-wrap rounded bg-black/40 p-4 text-left text-xs text-nf-muted">{error.message}</pre>
      </div>
    );
  }
}
