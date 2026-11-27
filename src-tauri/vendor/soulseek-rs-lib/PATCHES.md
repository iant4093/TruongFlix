# soulseek-rs-lib 20.0.0 (patched for TruongFlix)

Source: the published `soulseek-rs-lib-20.0.0` crate (https://github.com/michel/soulseek-rs, MIT).
Its examples and integration tests are omitted.

## Changes

- Brokered control connections are rationed (`Client::brokered_peer_allowed`, used where
  `ClientOperation::ConnectToPeer` is handled). A client whose listening port can't be reached
  from the internet receives every answer to its searches as a server request to connect out to
  the person answering. A popular search brings several hundred such requests within seconds, and
  upstream starts a connection attempt for each at once; most people answering are behind routers
  too, so the attempts hang. Measured on a home connection: about 1,000 attempts open within
  seconds of one search, the router's connection table filled, and the whole network went down.
  Now about 8 a second go through (with a burst of 16); the rest are answered with
  `CantConnectToPeer`, as if we were offline. People we're downloading from or uploading to (the
  library's protected peers) and file connections are never turned away.

Every change is marked with a `TruongFlix patch` comment.
