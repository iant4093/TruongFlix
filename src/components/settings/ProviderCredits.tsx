import tmdbLogo from '../../assets/tmdb.svg';

export default function ProviderCredits() {
  return <details className="text-xs text-nf-secondary">
    <summary className="cursor-pointer py-2 text-sm text-white/60 hover:text-white">Credits and licenses</summary>
    <div className="mt-3 space-y-4 rounded-lg border border-white/10 p-4 leading-relaxed">
      <img src={tmdbLogo} alt="TMDB" className="h-4 w-auto" />
      <p>This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
      <p>Browse discovery and popularity lists come from TMDB. IMDb ratings, when enabled and available, come from IMDb’s non-commercial datasets.</p>
      <p>Ad filtering uses adblock-rust by Brave Software and contributors (MPL 2.0).</p>
      <p>EasyList and EasyPrivacy by The EasyList authors (easylist.to), CC BY-SA 3.0 or later. Filter lists and licenses are included with the app. Cached updates are checked daily when the source browser opens and apply after restarting TruongFlix.</p>
    </div>
  </details>;
}
