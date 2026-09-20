# Changelog

## [0.1.1] - 2026-09-20

### Changed

- npm package name is `pi-fallback-models`. GitHub repository stays `pi-fallback`.

### Fixed

- Treat a missing current model as not already on the fallback, so typecheck passes under `strict`.

## [0.1.0] - 2026-09-19

### Added

- Ordered fallback chains with session, current-dir, and global scopes.
- `/fallback` editor, `/fallback-config` alias, and `/fallback-status`.
- Fallbacks for rate limits, transient provider/network failures, quota errors, unavailable models, and non-cancel stream aborts.
- Holds fallback until the 3rd consecutive failure when Pi or a goal extension is already retrying the same model.
- Routes activation through the pi-switch bus when that extension is installed, with a direct `setModel` fallback.
- Windows `settings.bat` for directory and global JSON settings.
