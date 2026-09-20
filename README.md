# pi-fallback-models

Tries your configured fallback models in order when the current Pi model encounters an eligible failure. Configure separate fallback chains for the current session, current directory, or all projects.

## Install

Choose one installation source.

```text
pi install npm:pi-fallback-models
pi install git:github.com/dev-willbird1936/pi-fallback
```

Restart Pi, or run `/reload` in an existing session.

## What it does

Eligible failures: rate limits, transient provider or network errors, quota errors, unavailable models, and non-cancel stream aborts.

Not retried: context overflow and user abort.

When Pi or a goal extension is already retrying the failed model, this extension waits until the third consecutive failure. A goal continuation that recovers on its own never triggers a fallback.

## Commands

| Command | Effect |
|---|---|
| `/fallback` | Open the editor |
| `/fallback-config` | Same editor |
| `/fallback-status` | Print the effective chain |

## Editor

- **Current** is Pi’s active model (`/model`).
- **Fallback 1**, **Fallback 2**, and so on are tried from top to bottom.
- **Enter** on a fallback row opens Pi’s model list.
- **Tab** switches **Session**, **Current dir**, and **Global**. `S`, `D`, and `G` jump to a scope.
- **Shift+Up/Down** reorders. **Backspace** clears. **R** resets the selected scope to inheritance.
- **Esc** saves and closes. `Ctrl+C` closes without saving.

Scope precedence:

```text
Current session → Current dir → Global
```

A session or directory scope without an override inherits the next scope. An explicitly empty chain disables fallback at that scope.

## Requirements

- Node.js `>=22.19.0`
- Pi Coding Agent
- Models that Pi currently lists

No API keys. Settings store model references only.

## Configuration

- Session: current Pi session extension state
- Directory: `<cwd>/.pi/pi-fallback.json` (only after the project is trusted)
- Global: `<Pi agent directory>/extensions/pi-fallback.json` (default `~/.pi/agent`)

An unreadable settings file is treated as an empty chain at that scope, not as inheritance.

If [pi-switch](https://github.com/dev-willbird1936/pi-switch) is installed, activation uses its bus (`pi-switch:request`) and falls back to a direct switch if the bus request fails.

Windows: `settings.bat [project-directory]` opens a local page for directory and global JSON.

By [dev-willbird1936](https://github.com/dev-willbird1936).
