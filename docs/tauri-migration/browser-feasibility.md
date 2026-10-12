# Retired browser feasibility work

The user approved removing browser features during migration on 2026-10-12. T02 is cancelled; D5 is accepted as removal; T11 covers removal and saved-data compatibility. Browser parity no longer blocks G0/G1.

The previous capability matrix and policy implementation were preparatory work in [#198](https://github.com/krazyjakee/21x/issues/198), not native browser parity. The unused migration-only policy, authority and 44 tests have been removed. The [historical report](https://github.com/krazyjakee/21x/tree/8f9b187/docs/tauri-migration) and implementation remain available in Git history; historical test evidence is retained in [implementation status](implementation-status.md).

The active [scope](README.md#approved-browser-removal), [retirement contract](architecture.md#browser-retirement-and-saved-data-compatibility) and [T11 task](workstreams.md#t11--retire-embedded-browser-features) remove browser/webpage embedding, automation and recordings while preserving dormant saved data. External authentication, external URL opening, artifact previews and app WebView security remain required.
