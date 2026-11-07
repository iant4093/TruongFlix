# inno 0.7.3 (patched for TruongFlix)

Source: the published `inno-0.7.3` crate (https://github.com/russellbanks/inno, MIT OR Apache-2.0).
Its integration tests are omitted.

## Changes

- `RunEntry::condition()` and `Icon::condition()`: upstream reads each entry's `Components`, `Tasks`,
  `Languages` and `Check` conditions but discards them. TruongFlix needs them to show only the
  after-install actions and shortcuts that apply to the chosen components and installer language.
- `Condition` derives `PartialEq`/`Eq` so `Icon` can keep deriving them.

Every change is marked with a `TruongFlix patch` comment.
