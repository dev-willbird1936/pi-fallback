# Changelog

## 0.1.0

Initial GitHub-ready release of `pi-ordered-fallback`.

- Ordered fallback chains with session, current-dir, and global scopes
- `/fallback` editor, `/fallback-config` alias, and `/fallback-status`
- Fallbacks for rate limits, transient provider/network failures, quota errors, unavailable models, and non-cancel stream aborts
- Holds fallback until the 3rd consecutive failure when Pi or a goal extension is already retrying the same model
- Routes activation through the pi-switch bus when that extension is installed, with a direct `setModel` fallback
- Model picker follows Pi's scoped list when present, otherwise `getAvailable()`, and uses `/model`-style search
- Windows `settings.bat` for directory and global JSON settings
- Settings page puts `cwd` in a `data-cwd` attribute instead of interpolating it into the script
- After a pi-switch bus success, `setModel` still runs unless the session is already on the fallback
- Install: `pi install git:github.com/dev-willbird1936/pi-fallback`
