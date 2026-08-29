# Pi Ordered Fallback

A Pi extension that tries fallback models in the exact order shown in its editor.

## Install

From GitHub, once this repository is available:

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

Pi only reads current-dir settings after the project is trusted. Untrusted projects ignore `.pi/pi-fallback.json`.

Only models Pi currently exposes in its normal model list can be selected. Fallbacks trigger for rate limits, transient provider/network failures, quota errors, and unavailable models. Context-overflow and user-abort errors are not retried.

For persistent settings outside Pi, run the Windows-only `settings.bat [project-directory]`; it opens a local browser page with a Save button. Use `/fallback` in Pi when choosing models from Pi's model picker.
