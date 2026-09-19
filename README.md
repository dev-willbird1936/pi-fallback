# Pi Ordered Fallback

A Pi extension that tries fallback models in the exact order shown in its editor.

## Install

From GitHub:

```text
pi install git:github.com/dev-willbird1936/pi-fallback
```

For a local checkout on Windows:

```bat
pi install C:\path\to\pi-fallback
```

Restart Pi or run `/reload`, then use the interactive TUI command:

```text
/fallback
```

`/fallback-config` is an alias. `/fallback-status` prints the effective chain.

## Editor

- **Current** is Pi's active model and is changed with `/model`.
- **Fallback 1**, **Fallback 2**, and so on are tried from top to bottom.
- Press **Enter** on a fallback row to choose from the same available model list Pi uses.
- **Tab** switches between **Session**, **Current dir**, and **Global** settings. `S`, `D`, and `G` jump directly to a scope.
- **Shift+Up/Down** reorders a fallback; **Backspace** clears one; **R** resets the selected scope to inheritance.
- **Esc** saves and closes. `Ctrl+C` closes without saving.

Scope precedence is:

```text
Current session → Current dir → Global
```

A session or directory scope without an override inherits the next scope. An explicitly empty chain disables fallback at that scope.

## Files

- Session settings are stored in the current Pi session as extension state.
- Current-dir settings: `<cwd>/.pi/pi-fallback.json`
- Global settings: `<Pi agent directory>/extensions/pi-fallback.json` (by default `~/.pi/agent`; honors `PI_CODING_AGENT_DIR`)

These files store model references only. This extension does not read or write provider API keys. A present but unreadable settings file is treated as an explicit empty chain (fallback disabled at that scope), not as inheritance.

Pi only reads current-dir settings after the project is trusted. Untrusted projects ignore `.pi/pi-fallback.json`.

Only models Pi currently exposes in its normal model list can be selected. Fallbacks trigger for rate limits, transient provider/network failures, quota errors, unavailable models, and non-cancel stream aborts. Context-overflow and user-abort errors are not retried.

When Pi or a goal extension is already retrying the failed model, fallback holds until the 3rd consecutive failure, so recoverable hiccups never yank the model; a stuck model that keeps failing still falls back. A goal continuation that recovers on its own never triggers a fallback. When the pi-switch extension is installed, activation routes through its bus (`pi-switch:request`, deferred mode) and falls back to a direct switch if the bus request fails; otherwise fallback switches directly.

For persistent settings outside Pi, run the Windows-only `settings.bat [project-directory]`; it opens a local browser page with a Save button. Use `/fallback` in Pi when choosing models from Pi's model picker.
