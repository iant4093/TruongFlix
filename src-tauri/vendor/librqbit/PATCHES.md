# librqbit 9.0.1 (patched for TruongFlix)

Source: the published `librqbit-9.0.1` crate (https://github.com/ikatson/rqbit, Apache-2.0).
The `webui` and test `resources` folders are omitted; neither is used by the features TruongFlix enables.

Upstream always downloads pieces in file order, which suits streaming but not plain downloads.

## Changes

- `AddTorrentOptions::sequential` (default `true`) and `ManagedTorrent::set_sequential` / `is_sequential`
  choose per torrent between in-order and rarest-first piece selection.
- `torrent_state/live/mod.rs`: when a torrent is not sequential, `rarest_candidates` samples up to 32
  needed pieces the peer has and orders them by how many connected peers have each one. They are tried
  after any active file-stream pieces and before the normal file-order queue.

Every change is marked with a `TruongFlix patch` comment.
