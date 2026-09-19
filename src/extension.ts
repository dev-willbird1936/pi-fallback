import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
  Input,
  matchesKey,
  SelectList,
  truncateToWidth,
  visibleWidth,
  type Component,
  type SelectItem,
} from "@earendil-works/pi-tui";
import * as piTuiNamespace from "@earendil-works/pi-tui";
import {
  fuzzyFilterModels,
  modelSearchText,
  normalizeChain,
  normalizeModelRef,
  resolveEffectiveFallbacks,
  resolveScope,
  sameOptionalChain,
  splitModelRef,
  type FallbackSettings,
  type ModelRef,
  type Scope,
} from "./logic.ts";

const EXTENSION_NAME = "pi-fallback";
const SESSION_ENTRY = "pi-fallback-settings";
const CONFIG_FILE = "pi-fallback.json";
const MAX_FALLBACKS = 50;
const MAX_VISIBLE_ROWS = 12;

export const RETRY_TOLERANCE = 3;

const SWITCH_REQUEST_CHANNEL = "pi-switch:request";
const SWITCHED_CHANNEL = "pi-switch:switched";
const SWITCH_FAILED_CHANNEL = "pi-switch:failed";
const SWITCH_BUS_TIMEOUT_MS = 8000;

interface DiskConfig {
  version?: number;
  fallbacks?: unknown;
}

interface SessionConfig {
  version?: number;
  fallbacks?: unknown;
}

type UserContent = Parameters<ExtensionAPI["sendUserMessage"]>[0];

export type ErrorBucket = "transient" | "quota" | "unavailable" | "ignore";

interface PendingFailure {
  bucket: Exclude<ErrorBucket, "ignore">;
  failed: ModelRef;
  userContent: UserContent;
  willRetry: boolean;
}

const TRANSIENT_ERROR =
  /overloaded|provider.?returned.?error|rate.?limit|too many requests|\b(?:429|500|502|503|504)\b|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;
const QUOTA_ERROR =
  /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|usage[ _-]?limit|available balance|credit balance|insufficient(?:_| )quota|insufficient(?:_| )balance|out of budget|(?:current|remaining) quota|quota exceeded|plan limit|no more (?:fast )?requests|billing/i;
const UNAVAILABLE_ERROR =
  /\b404\b|not_found_error|not[ _]found|is not available|model.?not.?available|does not exist|no such model|unsupported model|invalid model/i;
const CONTEXT_OVERFLOW_ERROR =
  /\b(?:context(?: window| length)?|prompt)\b.{0,80}\b(?:overflow|too (?:long|many tokens)|maximum|limit|exceed(?:ed)?)\b|\b(?:too many tokens|maximum context)\b/i;

export function classifyError(errorMessage: string | undefined): ErrorBucket {
  if (!errorMessage) return "ignore";
  if (CONTEXT_OVERFLOW_ERROR.test(errorMessage)) return "ignore";
  if (QUOTA_ERROR.test(errorMessage)) return "quota";
  if (UNAVAILABLE_ERROR.test(errorMessage)) return "unavailable";
  if (TRANSIENT_ERROR.test(errorMessage)) return "transient";
  return "ignore";
}

function sessionModelRef(ctx: ExtensionContext): string | undefined {
  const model = ctx.model;
  return model ? `${model.provider}/${model.id}` : undefined;
}

function isCancellationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    (error instanceof Error && error.name === "AbortError") ||
    /\b(?:abort(?:ed|ing)?|cancel(?:led|ed|lation)?)\b/i.test(message)
  );
}

function cloneSettings(settings: FallbackSettings): FallbackSettings {
  return {
    session: settings.session ? [...settings.session] : undefined,
    directory: settings.directory ? [...settings.directory] : undefined,
    global: settings.global ? [...settings.global] : undefined,
  };
}

function readConfigFile(path: string): ModelRef[] | undefined {
  if (!existsSync(path)) return undefined;

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as DiskConfig;
    return normalizeChain(parsed?.fallbacks).slice(0, MAX_FALLBACKS);
  } catch (error) {
    console.error(`[${EXTENSION_NAME}] invalid config at ${path}:`, error);
    // A present but broken file is treated as an explicit empty chain rather than
    // silently activating a less-specific fallback configuration.
    return [];
  }
}

function writeConfigFile(path: string, fallbacks: ModelRef[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ version: 1, fallbacks }, null, 2)}\n`,
    "utf8",
  );
}

function removeConfigFile(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

function readSessionConfig(ctx: ExtensionContext): ModelRef[] | undefined {
  let result: ModelRef[] | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== SESSION_ENTRY) continue;
    const data = entry.data as SessionConfig | undefined;
    if (data?.fallbacks === null) {
      result = undefined;
    } else if (Array.isArray(data?.fallbacks)) {
      result = normalizeChain(data.fallbacks).slice(0, MAX_FALLBACKS);
    }
  }
  return result;
}

function directoryConfigPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, CONFIG_FILE);
}

function globalConfigPath(): string {
  return join(getAgentDir(), "extensions", CONFIG_FILE);
}

function modelRef(model: Model<any> | undefined): ModelRef | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}

function sameRef(a: ModelRef | undefined, b: ModelRef | undefined): boolean {
  return a !== undefined && b !== undefined && a === b;
}

function displayModelRef(ctx: ExtensionContext, ref: ModelRef): string {
  const parts = splitModelRef(ref);
  if (!parts) return ref;
  const model = ctx.modelRegistry.find(parts.provider, parts.id);
  if (!model || !model.name || model.name === model.id) return ref;
  return `${ref} — ${model.name}`;
}

function selectableModels(ctx: ExtensionContext): Model<any>[] {
  // Prefer Pi's project-scoped list when the host provides one, matching /model.
  const models =
    ctx.scopedModels.length > 0
      ? ctx.scopedModels.map((entry) => entry.model)
      : ctx.modelRegistry.getAvailable();
  const unique = new Map<string, Model<any>>();
  for (const model of models)
    unique.set(`${model.provider}/${model.id}`, model);
  return [...unique.values()];
}

// The host Pi's fuzzy matcher when it exports one, otherwise the vendored
// mirror in logic.ts (same /model semantics either way).
const hostFuzzyFilter =
  (
    piTuiNamespace as unknown as {
      fuzzyFilter?: <T>(
        items: T[],
        query: string,
        getText: (item: T) => string,
      ) => T[];
    }
  ).fuzzyFilter ?? null;

function filterPickerModels<T>(
  items: T[],
  query: string,
  getText: (item: T) => string,
): T[] {
  if (!query.trim()) return items;
  if (hostFuzzyFilter) return hostFuzzyFilter(items, query, getText);
  return fuzzyFilterModels(items, query, getText);
}

function sourceLabel(source: Scope | "none"): string {
  switch (source) {
    case "session":
      return "current session";
    case "directory":
      return "current dir";
    case "global":
      return "global";
    default:
      return "none";
  }
}

function scopeLabel(scope: Scope): string {
  switch (scope) {
    case "session":
      return "Session";
    case "directory":
      return "Current dir";
    case "global":
      return "Global";
  }
}

function isEnter(data: string): boolean {
  return (
    data === "\n" || matchesKey(data, "enter") || matchesKey(data, "return")
  );
}

function isClear(data: string): boolean {
  return matchesKey(data, "backspace") || matchesKey(data, "delete");
}

function scopeChain(settings: FallbackSettings, scope: Scope): ModelRef[] {
  return resolveScope(settings, scope).fallbacks.slice(0, MAX_FALLBACKS);
}

function statusText(
  chain: ModelRef[],
  activeIndex: number | undefined,
  exhausted: boolean,
  failures: number,
): string | undefined {
  if (chain.length === 0) return undefined;
  if (exhausted) return `fallbacks exhausted (${chain.length})`;
  if (activeIndex === undefined) {
    const ready = `${chain.length} fallback${chain.length === 1 ? "" : "s"} ready`;
    return failures > 0 ? `${ready} · retry ${failures}/${RETRY_TOLERANCE}` : ready;
  }
  return `fallback ${activeIndex + 1}/${chain.length}`;
}

class ModelPicker implements Component {
  private readonly tui: { requestRender(): void };
  private readonly theme: any;
  private readonly done: (ref: string | undefined) => void;
  private readonly search = new Input();
  private readonly models: Model<any>[];
  private readonly selectedRef: ModelRef | undefined;
  private readonly maxVisible: number;
  private list: SelectList;
  private searchFocused = true;
  private _focused = false;

  constructor(
    tui: { requestRender(): void },
    theme: any,
    models: Model<any>[],
    selectedRef: ModelRef | undefined,
    done: (ref: string | undefined) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    this.models = models;
    this.selectedRef = selectedRef;
    this.maxVisible = Math.min(12, Math.max(1, models.length));
    this.list = this.buildList("");
    this.search.onSubmit = () => this.selectCurrent();
    this.syncFocus();
  }

  private toItem(model: Model<any>): SelectItem {
    const ref = modelRef(model)!;
    return {
      value: ref,
      label: ref,
      description:
        model.name && model.name !== model.id ? model.name : undefined,
    };
  }

  private buildList(query: string): SelectList {
    const visible = filterPickerModels(
      this.models,
      query,
      (model) =>
        modelSearchText({
          provider: model.provider,
          id: model.id,
          name: model.name,
        }),
    );
    const list = new SelectList(
      visible.map((model) => this.toItem(model)),
      Math.min(this.maxVisible, Math.max(1, visible.length)),
      {
        selectedPrefix: (text) => this.theme.fg("accent", text),
        selectedText: (text) => this.theme.fg("accent", text),
        description: (text) => this.theme.fg("muted", text),
        scrollInfo: (text) => this.theme.fg("dim", text),
        noMatch: (text) => this.theme.fg("warning", text),
      },
    );
    const selectedIndex = visible.findIndex(
      (model) => modelRef(model) === this.selectedRef,
    );
    list.setSelectedIndex(selectedIndex >= 0 ? selectedIndex : 0);
    list.onSelect = (item) => this.done(item.value);
    list.onCancel = () => this.done(undefined);
    return list;
  }

  private refreshFilter(): void {
    this.list = this.buildList(this.search.getValue());
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.syncFocus();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+c") || matchesKey(data, "escape")) {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, "tab")) {
      this.searchFocused = !this.searchFocused;
      this.syncFocus();
      this.tui.requestRender();
      return;
    }
    if (this.searchFocused) {
      if (
        matchesKey(data, "up") ||
        matchesKey(data, "down") ||
        matchesKey(data, "pageUp") ||
        matchesKey(data, "pageDown")
      ) {
        this.searchFocused = false;
        this.syncFocus();
        this.list.handleInput(data);
      } else if (isEnter(data)) {
        this.selectCurrent();
        return;
      } else {
        this.search.handleInput(data);
        this.refreshFilter();
      }
    } else {
      this.list.handleInput(data);
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - 2);
    const border = this.theme.fg("border", "│");
    const horizontal = this.theme.fg("border", "─".repeat(contentWidth));
    const frame = (text: string): string => {
      const safe = truncateToWidth(text, contentWidth, "…");
      return `${border}${safe}${" ".repeat(Math.max(0, contentWidth - visibleWidth(safe)))}${border}`;
    };
    const divider = `${this.theme.fg("border", "├")}${horizontal}${this.theme.fg("border", "┤")}`;
    const top = `${this.theme.fg("border", "┌")}${horizontal}${this.theme.fg("border", "┐")}`;
    const bottom = `${this.theme.fg("border", "└")}${horizontal}${this.theme.fg("border", "┘")}`;
    const searchLine = this.search.render(contentWidth)[0] ?? "";
    const lines = [
      top,
      frame(
        ` ${this.theme.fg("accent", this.theme.bold("Choose fallback model"))}`,
      ),
      frame(
        ` ${this.theme.fg("dim", this.searchFocused ? "Type to filter; Tab moves to the list" : "Tab returns to search")}`,
      ),
      frame(`${this.theme.fg("muted", " Search: ")}${searchLine}`),
      divider,
      ...this.list.render(contentWidth).map((line) => frame(line)),
      divider,
      frame(
        ` ${this.theme.fg("dim", "↑↓ navigate · Enter choose · Tab search/list · Esc cancel")}`,
      ),
      bottom,
    ];
    return lines;
  }

  invalidate(): void {
    this.search.invalidate();
    this.list.invalidate();
  }

  private syncFocus(): void {
    this.search.focused = this._focused && this.searchFocused;
  }

  private selectCurrent(): void {
    const selected = this.list.getSelectedItem();
    if (selected) this.done(selected.value);
  }
}

class FallbackEditor implements Component {
  private readonly ctx: ExtensionCommandContext;
  private readonly theme: any;
  private readonly tui: { requestRender(): void };
  private readonly done: (settings: FallbackSettings | undefined) => void;
  private readonly canEditDirectory: boolean;
  private settings: FallbackSettings;
  private scope: Scope = "session";
  private selectedRow = 1;
  private busy = false;

  constructor(
    ctx: ExtensionCommandContext,
    tui: { requestRender(): void },
    theme: any,
    settings: FallbackSettings,
    canEditDirectory: boolean,
    done: (settings: FallbackSettings | undefined) => void,
  ) {
    this.ctx = ctx;
    this.tui = tui;
    this.theme = theme;
    this.settings = cloneSettings(settings);
    this.canEditDirectory = canEditDirectory;
    this.done = done;
  }

  handleInput(data: string): void {
    if (this.busy) return;

    if (matchesKey(data, "ctrl+c")) {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+s")) {
      this.done(this.settings);
      return;
    }
    if (matchesKey(data, "tab")) {
      this.scope =
        this.scope === "session"
          ? "directory"
          : this.scope === "directory"
            ? "global"
            : "session";
      this.selectedRow = 1;
      this.tui.requestRender();
      return;
    }
    if (data === "s" && !matchesKey(data, "shift+s")) {
      this.scope = "session";
      this.selectedRow = 1;
      this.tui.requestRender();
      return;
    }
    if (data === "d" && !matchesKey(data, "shift+d")) {
      this.scope = "directory";
      this.selectedRow = 1;
      this.tui.requestRender();
      return;
    }
    if (data === "g" && !matchesKey(data, "shift+g")) {
      this.scope = "global";
      this.selectedRow = 1;
      this.tui.requestRender();
      return;
    }
    if (data.toLowerCase() === "r") {
      this.resetScope();
      return;
    }
    if (matchesKey(data, "shift+up")) {
      this.moveFallback(-1);
      return;
    }
    if (matchesKey(data, "shift+down")) {
      this.moveFallback(1);
      return;
    }

    const rows = this.rowCount();
    if (matchesKey(data, "up")) {
      this.selectedRow = Math.max(0, this.selectedRow - 1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      this.selectedRow = Math.min(rows - 1, this.selectedRow + 1);
      this.tui.requestRender();
      return;
    }
    if (isClear(data)) {
      this.clearFallback();
      return;
    }
    if (isEnter(data)) {
      void this.chooseFallback();
    }
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - 2);
    const border = this.theme.fg("border", "│");
    const horizontal = this.theme.fg("border", "─".repeat(contentWidth));
    const frame = (text: string): string => {
      const safe = truncateToWidth(text, contentWidth, "…");
      return `${border}${safe}${" ".repeat(Math.max(0, contentWidth - visibleWidth(safe)))}${border}`;
    };
    const divider = `${this.theme.fg("border", "├")}${horizontal}${this.theme.fg("border", "┤")}`;
    const top = `${this.theme.fg("border", "┌")}${horizontal}${this.theme.fg("border", "┐")}`;
    const bottom = `${this.theme.fg("border", "└")}${horizontal}${this.theme.fg("border", "┘")}`;
    const lines: string[] = [top];

    lines.push(
      frame(` ${this.theme.fg("accent", this.theme.bold("Fallback models"))}`),
    );
    lines.push(
      frame(` ${this.theme.fg("muted", "Scope:")} ${this.renderScopes()}`),
    );
    lines.push(frame(` ${this.theme.fg("dim", this.scopeDescription())}`));
    if (this.scope === "directory" && !this.canEditDirectory) {
      lines.push(
        frame(
          ` ${this.theme.fg("warning", "Current dir settings unavailable until this project is trusted")}`,
        ),
      );
    }
    lines.push(divider);

    const current = modelRef(this.ctx.model) ?? "(no model selected)";
    const currentLine = `${this.rowMarker(0)}Current: ${this.theme.fg("text", current)}`;
    lines.push(frame(currentLine));

    const chain = scopeChain(this.settings, this.scope);
    const rows = this.fallbackRowCount();
    const visible = Math.min(MAX_VISIBLE_ROWS, rows);
    let start = 0;
    if (rows > visible) {
      start = Math.max(
        0,
        Math.min(this.selectedRow - Math.floor(visible / 2), rows - visible),
      );
    }
    if (start > 0)
      lines.push(frame(` ${this.theme.fg("dim", "… more fallbacks above")}`));
    for (let row = start; row < Math.min(rows, start + visible); row++) {
      const value =
        row < chain.length
          ? displayModelRef(this.ctx, chain[row]!)
          : chain.length >= MAX_FALLBACKS
            ? "(maximum reached)"
            : "(not set — Enter to choose)";
      const valueStyle = row < chain.length ? "text" : "dim";
      lines.push(
        frame(
          `${this.rowMarker(row + 1)}Fallback ${row + 1}: ${this.theme.fg(valueStyle, value)}`,
        ),
      );
    }
    if (start + visible < rows)
      lines.push(frame(` ${this.theme.fg("dim", "… more fallbacks below")}`));

    lines.push(divider);
    if (this.busy)
      lines.push(frame(` ${this.theme.fg("accent", "Choosing a model…")}`));
    lines.push(
      frame(
        ` ${this.theme.fg("dim", "Tab scope · S/D/G jump · ↑↓ row · Enter choose")}`,
      ),
    );
    lines.push(
      frame(
        ` ${this.theme.fg("dim", "Shift+↑↓ reorder · Backspace clear · R reset/inherit · Esc save")}`,
      ),
    );
    lines.push(bottom);
    return lines;
  }

  invalidate(): void {
    // Rendered strings are built from current state and the current theme each time.
  }

  private renderScopes(): string {
    return (["session", "directory", "global"] as Scope[])
      .map((scope) => {
        const label = scopeLabel(scope);
        return scope === this.scope
          ? this.theme.bg("selectedBg", this.theme.fg("accent", ` ${label} `))
          : this.theme.fg("muted", ` ${label} `);
      })
      .join(this.theme.fg("dim", "  "));
  }

  private scopeDescription(): string {
    const own = this.settings[this.scope] !== undefined;
    const resolved = resolveScope(this.settings, this.scope);
    if (this.scope === "global") {
      return own
        ? "Global defaults (saved for every project)"
        : "Global defaults are not configured";
    }
    if (own)
      return `${scopeLabel(this.scope)} override is active; it wins over less-specific settings`;
    return `Inherited from ${sourceLabel(resolved.source)}; edit a row to create a ${scopeLabel(this.scope).toLowerCase()} override`;
  }

  private rowMarker(row: number): string {
    return row === this.selectedRow ? this.theme.fg("accent", "▶ ") : "  ";
  }

  private fallbackRowCount(): number {
    return Math.min(
      MAX_FALLBACKS + 1,
      scopeChain(this.settings, this.scope).length + 1,
    );
  }

  private rowCount(): number {
    return 1 + this.fallbackRowCount();
  }

  private ensureOwnChain(): ModelRef[] | undefined {
    if (this.scope === "directory" && !this.canEditDirectory) {
      this.ctx.ui.notify(
        "Trust this project before changing current-dir fallback settings.",
        "warning",
      );
      return undefined;
    }
    if (this.settings[this.scope] === undefined) {
      this.settings[this.scope] = scopeChain(this.settings, this.scope);
    }
    return this.settings[this.scope]!;
  }

  private clearFallback(): void {
    if (this.selectedRow === 0) {
      this.ctx.ui.notify(
        "Current is Pi's active model. Change it with /model; fallback rows are editable.",
        "info",
      );
      return;
    }
    const visibleChain = scopeChain(this.settings, this.scope);
    if (this.selectedRow > visibleChain.length) return;
    const chain = this.ensureOwnChain();
    if (!chain) return;
    chain.splice(this.selectedRow - 1, 1);
    this.selectedRow = Math.min(this.selectedRow, chain.length + 1);
    this.tui.requestRender();
  }

  private resetScope(): void {
    if (this.scope === "directory" && !this.canEditDirectory) {
      this.ctx.ui.notify(
        "Trust this project before changing current-dir fallback settings.",
        "warning",
      );
      return;
    }
    this.settings[this.scope] = undefined;
    this.selectedRow = 1;
    this.ctx.ui.notify(
      `${scopeLabel(this.scope)} reset; it now inherits less-specific settings.`,
      "info",
    );
    this.tui.requestRender();
  }

  private moveFallback(direction: -1 | 1): void {
    if (this.selectedRow <= 0) return;
    const visibleChain = scopeChain(this.settings, this.scope);
    const index = this.selectedRow - 1;
    const target = index + direction;
    if (
      index >= visibleChain.length ||
      target < 0 ||
      target >= visibleChain.length
    )
      return;
    const chain = this.ensureOwnChain();
    if (!chain) return;
    [chain[index], chain[target]] = [chain[target]!, chain[index]!];
    this.selectedRow += direction;
    this.tui.requestRender();
  }

  private async chooseFallback(): Promise<void> {
    if (this.selectedRow === 0) {
      this.ctx.ui.notify(
        "Current is Pi's active model. Use /model to change it.",
        "info",
      );
      return;
    }
    if (this.scope === "directory" && !this.canEditDirectory) {
      this.ctx.ui.notify(
        "Trust this project before changing current-dir fallback settings.",
        "warning",
      );
      return;
    }

    const models = selectableModels(this.ctx);
    if (models.length === 0) {
      this.ctx.ui.notify(
        "No models are available in Pi's model list. Configure a provider first.",
        "warning",
      );
      return;
    }

    const existingRef = scopeChain(this.settings, this.scope)[
      this.selectedRow - 1
    ];
    this.busy = true;
    this.tui.requestRender();
    try {
      const ref = await this.ctx.ui.custom<string | undefined>(
        (tui, theme, _keybindings, done) =>
          new ModelPicker(tui, theme, models, existingRef, done),
        {
          overlay: true,
          overlayOptions: { width: "90%", maxHeight: "90%", minWidth: 64 },
        },
      );
      if (!ref) return;
      const chain = this.ensureOwnChain();
      if (!chain) return;
      const index = this.selectedRow - 1;
      if (
        chain.some(
          (existing, existingIndex) =>
            existing === ref && existingIndex !== index,
        )
      ) {
        this.ctx.ui.notify(
          `${ref} is already in this fallback chain.`,
          "warning",
        );
        return;
      }
      if (index >= chain.length) {
        if (chain.length >= MAX_FALLBACKS) {
          this.ctx.ui.notify(
            `Fallback chains are limited to ${MAX_FALLBACKS} models.`,
            "warning",
          );
          return;
        }
        chain.push(ref);
      } else {
        chain[index] = ref;
      }
      this.settings[this.scope] = normalizeChain(chain).slice(0, MAX_FALLBACKS);
      this.selectedRow = Math.min(this.selectedRow + 1, this.rowCount() - 1);
    } finally {
      this.busy = false;
      this.tui.requestRender();
    }
  }
}

export default function piFallbackExtension(pi: ExtensionAPI): void {
  let sessionFallbacks: ModelRef[] | undefined;
  let directoryFallbacks: ModelRef[] | undefined;
  let globalFallbacks: ModelRef[] | undefined;
  let baselineModel: ModelRef | undefined;
  let fallbackIndex = 0;
  let activeFallbackIndex: number | undefined;
  let fallbackExhausted = false;
  let fallbackTarget: ModelRef | undefined;
  let restoringBaseline = false;
  let pendingFailure: PendingFailure | undefined;
  let continuationAfterFailure = false;
  let lastUserContent: UserContent | undefined;
  let consecutiveFailures = 0;
  let consecutiveFailedRef: ModelRef | undefined;
  const switchWaiters: {
    ref: ModelRef;
    resolve: (ok: boolean, error?: string) => void;
  }[] = [];
  let switchListenersAttached = false;

  function currentSettings(): FallbackSettings {
    return {
      session: sessionFallbacks,
      directory: directoryFallbacks,
      global: globalFallbacks,
    };
  }

  function effectiveChain(): ModelRef[] {
    return resolveEffectiveFallbacks(currentSettings()).fallbacks;
  }

  function updateStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus(
      "pi-fallback",
      statusText(
        effectiveChain(),
        activeFallbackIndex,
        fallbackExhausted,
        consecutiveFailures,
      ),
    );
  }

  function refreshPersistentSettings(ctx: ExtensionContext): void {
    directoryFallbacks = ctx.isProjectTrusted()
      ? readConfigFile(directoryConfigPath(ctx.cwd))
      : undefined;
    globalFallbacks = readConfigFile(globalConfigPath());
  }

  function resetRuntimeState(ctx: ExtensionContext): void {
    fallbackIndex = 0;
    activeFallbackIndex = undefined;
    fallbackExhausted = false;
    fallbackTarget = undefined;
    pendingFailure = undefined;
    continuationAfterFailure = false;
    consecutiveFailures = 0;
    consecutiveFailedRef = undefined;
    updateStatus(ctx);
  }

  function saveSessionConfig(next: ModelRef[] | undefined): void {
    pi.appendEntry(SESSION_ENTRY, { version: 1, fallbacks: next ?? null });
  }

  async function saveSettings(
    next: FallbackSettings,
    previous: FallbackSettings,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    if (!sameOptionalChain(next.session, previous.session)) {
      sessionFallbacks = next.session
        ? normalizeChain(next.session).slice(0, MAX_FALLBACKS)
        : undefined;
      saveSessionConfig(sessionFallbacks);
    }

    if (!sameOptionalChain(next.directory, previous.directory)) {
      if (!ctx.isProjectTrusted()) {
        ctx.ui.notify(
          "Could not save current-dir settings because this project is not trusted.",
          "error",
        );
      } else {
        directoryFallbacks = next.directory
          ? normalizeChain(next.directory).slice(0, MAX_FALLBACKS)
          : undefined;
        if (directoryFallbacks === undefined)
          removeConfigFile(directoryConfigPath(ctx.cwd));
        else writeConfigFile(directoryConfigPath(ctx.cwd), directoryFallbacks);
      }
    }

    if (!sameOptionalChain(next.global, previous.global)) {
      globalFallbacks = next.global
        ? normalizeChain(next.global).slice(0, MAX_FALLBACKS)
        : undefined;
      if (globalFallbacks === undefined) removeConfigFile(globalConfigPath());
      else writeConfigFile(globalConfigPath(), globalFallbacks);
    }

    resetRuntimeState(ctx);
    ctx.ui.notify("Fallback settings saved.", "info");
  }

  async function openEditor(
    _args: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    if (ctx.mode !== "tui") {
      ctx.ui.notify(
        "Fallback settings require Pi's interactive TUI.",
        "warning",
      );
      return;
    }

    refreshPersistentSettings(ctx);
    const previous = currentSettings();
    const result = await ctx.ui.custom<FallbackSettings | undefined>(
      (tui, theme, _keybindings, done) =>
        new FallbackEditor(
          ctx,
          tui,
          theme,
          previous,
          ctx.isProjectTrusted(),
          done,
        ),
      {
        overlay: true,
        overlayOptions: { width: "90%", maxHeight: "90%", minWidth: 64 },
      },
    );
    if (!result) return;
    await saveSettings(result, previous, ctx);
  }

  pi.on("session_start", async (_event, ctx) => {
    sessionFallbacks = readSessionConfig(ctx);
    refreshPersistentSettings(ctx);
    if (!baselineModel) baselineModel = modelRef(ctx.model);
    lastUserContent = undefined;
    resetRuntimeState(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    sessionFallbacks = readSessionConfig(ctx);
    resetRuntimeState(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const baseline = baselineModel;
    baselineModel = undefined;
    lastUserContent = undefined;
    fallbackTarget = undefined;
    if (!baseline || sameRef(modelRef(ctx.model), baseline)) return;

    const restore = splitModelRef(baseline);
    const model = restore
      ? ctx.modelRegistry.find(restore.provider, restore.id)
      : undefined;
    if (!model) {
      ctx.ui.notify(
        `[${EXTENSION_NAME}] could not restore ${baseline} before shutdown.`,
        "warning",
      );
      return;
    }

    restoringBaseline = true;
    try {
      let ok = false;
      let restoreError: unknown;
      try {
        ok = await pi.setModel(model);
      } catch (error) {
        restoreError = error;
      }
      if (!ok) {
        const detail = restoreError
          ? `: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`
          : "";
        ctx.ui.notify(
          `[${EXTENSION_NAME}] could not restore ${baseline} before shutdown${detail}.`,
          "warning",
        );
      }
    } finally {
      restoringBaseline = false;
    }
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role === "user") {
      // Goal/continuation extensions can append a user message after a failed run
      // but before agent_settled. Keep the original failure pending for fallback.
      if (pendingFailure) continuationAfterFailure = true;
      lastUserContent = event.message.content;
    } else if (
      event.message.role === "assistant" &&
      event.message.stopReason !== "error" &&
      event.message.stopReason !== "aborted"
    ) {
      // Any successful assistant message — Pi's built-in retry succeeding or a
      // goal continuation recovering on its own — clears failure state, so a
      // hiccup the goal works through never triggers a fallback.
      pendingFailure = undefined;
      continuationAfterFailure = false;
      consecutiveFailures = 0;
      consecutiveFailedRef = undefined;
      updateStatus(ctx);
    }
  });

  pi.on("model_select", async (event, ctx) => {
    const selected = modelRef(event.model);
    if (fallbackTarget && selected === fallbackTarget) {
      fallbackTarget = undefined;
      updateStatus(ctx);
      return;
    }
    if (
      !restoringBaseline &&
      (event.source === "set" ||
        event.source === "cycle" ||
        event.source === "restore" ||
        !baselineModel)
    ) {
      baselineModel = selected;
      resetRuntimeState(ctx);
    }
    updateStatus(ctx);
  });

  pi.on("agent_end", async (event, ctx) => {
    const last = [...event.messages]
      .reverse()
      .find(
        (message): message is AssistantMessage => message.role === "assistant",
      );
    if (!last || !ctx.model) return;
    const failedRef = modelRef(ctx.model) ?? `${last.provider}/${last.model}`;

    // A non-error abort with a cancel-like (or empty) message is the user
    // stopping the run: fresh intent, drop failure state instead of counting it.
    const abortedFailure =
      last.stopReason === "aborted" &&
      !!last.errorMessage &&
      !isCancellationError(last.errorMessage);
    if (last.stopReason !== "error" && !abortedFailure) {
      if (last.stopReason === "aborted") {
        pendingFailure = undefined;
        continuationAfterFailure = false;
        consecutiveFailures = 0;
        consecutiveFailedRef = undefined;
        updateStatus(ctx);
      }
      return;
    }

    const bucket = classifyError(last.errorMessage);
    if (bucket === "ignore" || lastUserContent === undefined) {
      return;
    }

    consecutiveFailures = sameRef(consecutiveFailedRef, failedRef)
      ? consecutiveFailures + 1
      : 1;
    consecutiveFailedRef = failedRef;
    pendingFailure = {
      bucket,
      failed: failedRef,
      userContent: lastUserContent,
      willRetry:
        (event as unknown as { willRetry?: boolean }).willRetry === true,
    };
    continuationAfterFailure = false;
    updateStatus(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const failure = pendingFailure;
    if (!failure || !ctx.model) {
      pendingFailure = undefined;
      continuationAfterFailure = false;
      return;
    }
    // Pi's built-in retry or a goal continuation is about to retry the same
    // model. Hold the fallback until RETRY_TOLERANCE consecutive failures so
    // recoverable hiccups never yank the model; a stuck model that keeps
    // failing still falls back once tolerance is reached.
    if (
      (failure.willRetry || continuationAfterFailure) &&
      consecutiveFailures < RETRY_TOLERANCE
    ) {
      continuationAfterFailure = false;
      updateStatus(ctx);
      return;
    }
    pendingFailure = undefined;
    continuationAfterFailure = false;
    await tryFallback(ctx, failure);
  });

  function piSwitchAvailable(): boolean {
    try {
      if (typeof pi.events?.on !== "function" || typeof pi.events?.emit !== "function")
        return false;
      return (pi.getCommands() ?? []).some(
        (command) => command.name === "switch",
      );
    } catch {
      return false;
    }
  }

  function ensureSwitchListeners(): void {
    if (switchListenersAttached) return;
    if (typeof pi.events?.on !== "function") {
      throw new Error("pi.events is unavailable");
    }
    pi.events.on(SWITCHED_CHANNEL, (data: unknown) => {
      const to = (data as { to?: unknown } | null)?.to;
      if (typeof to !== "string") return;
      const index = switchWaiters.findIndex((waiter) => waiter.ref === to);
      if (index >= 0) switchWaiters.splice(index, 1)[0]?.resolve(true);
    });
    pi.events.on(SWITCH_FAILED_CHANNEL, (data: unknown) => {
      const payload =
        (data as { model?: unknown; error?: unknown } | null) ?? {};
      if (typeof payload.model !== "string") return;
      const index = switchWaiters.findIndex(
        (waiter) => waiter.ref === payload.model,
      );
      if (index >= 0)
        switchWaiters.splice(index, 1)[0]?.resolve(
          false,
          typeof payload.error === "string" ? payload.error : "unknown error",
        );
    });
    switchListenersAttached = true;
  }

  function requestSwitchViaBus(
    candidateRef: ModelRef,
    reason: string,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      ensureSwitchListeners();
    } catch (error) {
      return Promise.resolve({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return new Promise((resolve) => {
      const waiter: (typeof switchWaiters)[number] = {
        ref: candidateRef,
        resolve: (ok: boolean, error?: string) => {
          clearTimeout(timer);
          resolve({ ok, error });
        },
      };
      const timer = setTimeout(() => {
        const index = switchWaiters.indexOf(waiter);
        if (index >= 0) switchWaiters.splice(index, 1);
        resolve({ ok: false, error: "timed out waiting for pi-switch" });
      }, SWITCH_BUS_TIMEOUT_MS);
      (timer as unknown as { unref?: () => void }).unref?.();
      switchWaiters.push(waiter);
      try {
        pi.events.emit(SWITCH_REQUEST_CHANNEL, {
          model: candidateRef,
          mode: "deferred",
          reason,
          compact: false,
        });
      } catch (error) {
        clearTimeout(timer);
        const index = switchWaiters.indexOf(waiter);
        if (index >= 0) switchWaiters.splice(index, 1);
        resolve({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  async function activateModel(
    ctx: ExtensionContext,
    candidate: Model<any>,
    candidateRef: ModelRef,
    failure: PendingFailure,
  ): Promise<{ ok: boolean; error?: string }> {
    const alreadyOnCandidate = sessionModelRef(ctx) === candidateRef;
    if (alreadyOnCandidate) return { ok: true };
    // Prefer pi-switch when it is installed so the switch goes through the
    // same path as /switch. Always confirm with setModel so a premature
    // switched event cannot leave the failed model active.
    if (piSwitchAvailable()) {
      const via = await requestSwitchViaBus(
        candidateRef,
        `pi-fallback: ${failure.failed} failed (${failure.bucket})`,
      );
      if (sessionModelRef(ctx) === candidateRef) return { ok: true };
      if (!via.ok) {
        ctx.ui.notify(
          `[${EXTENSION_NAME}] pi-switch could not activate ${candidateRef} (${via.error ?? "unknown error"}); switching directly.`,
          "warning",
        );
      }
    }
    try {
      return { ok: await pi.setModel(candidate) };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function tryFallback(
    ctx: ExtensionContext,
    failure: PendingFailure,
  ): Promise<void> {
    refreshPersistentSettings(ctx);
    const chain = effectiveChain();
    if (chain.length === 0) return;

    while (fallbackIndex < chain.length) {
      const index = fallbackIndex++;
      const candidateRef = normalizeModelRef(chain[index]);
      if (!candidateRef || candidateRef === failure.failed) continue;
      const candidateParts = splitModelRef(candidateRef);
      if (!candidateParts) continue;
      const candidate = ctx.modelRegistry.find(
        candidateParts.provider,
        candidateParts.id,
      );
      if (!candidate) {
        ctx.ui.notify(
          `[${EXTENSION_NAME}] skipping missing model ${candidateRef}.`,
          "warning",
        );
        continue;
      }

      fallbackTarget = candidateRef;
      const activation = await activateModel(
        ctx,
        candidate,
        candidateRef,
        failure,
      );
      if (!activation.ok) {
        fallbackTarget = undefined;
        const detail = activation.error ? `: ${activation.error}` : "";
        ctx.ui.notify(
          `[${EXTENSION_NAME}] skipping unavailable model ${candidateRef}${detail}.`,
          "warning",
        );
        continue;
      }

      activeFallbackIndex = index;
      fallbackExhausted = false;
      updateStatus(ctx);
      ctx.ui.notify(
        `[${EXTENSION_NAME}] ${failure.failed} failed (${failure.bucket}) → ${candidateRef}`,
        "warning",
      );
      retryAfterCompaction(ctx, candidate, candidateRef, failure.userContent);
      return;
    }

    fallbackExhausted = true;
    updateStatus(ctx);
    ctx.ui.notify(
      `[${EXTENSION_NAME}] no usable fallback remains after ${failure.failed} (${failure.bucket}).`,
      "error",
    );
  }

  function retryLastUserMessage(
    ctx: ExtensionContext,
    content: UserContent,
  ): void {
    if (ctx.isIdle()) pi.sendUserMessage(content);
    else pi.sendUserMessage(content, { deliverAs: "followUp" });
  }

  function retryAfterCompaction(
    ctx: ExtensionContext,
    target: Model<any>,
    targetRef: ModelRef,
    content: UserContent,
  ): void {
    const usage = ctx.getContextUsage();
    const tokens = typeof usage?.tokens === "number" ? usage.tokens : undefined;
    const targetWindow =
      typeof target.contextWindow === "number"
        ? target.contextWindow
        : undefined;
    const reserveTokens = 16_384;
    const needsCompaction =
      tokens !== undefined &&
      targetWindow !== undefined &&
      tokens > Math.max(0, targetWindow - reserveTokens);

    if (!needsCompaction) {
      retryLastUserMessage(ctx, content);
      return;
    }

    ctx.ui.notify(
      `[${EXTENSION_NAME}] compacting before retry on ${targetRef}…`,
      "warning",
    );
    ctx.compact({
      customInstructions: `Preserve details needed to continue after fallback to ${targetRef}.`,
      onComplete: () => retryLastUserMessage(ctx, content),
      onError: (error) => {
        if (isCancellationError(error)) {
          ctx.ui.notify(`[${EXTENSION_NAME}] compaction cancelled; retry stopped.`, "info");
          return;
        }
        ctx.ui.notify(
          `[${EXTENSION_NAME}] compaction failed: ${error.message}; retrying anyway.`,
          "warning",
        );
        retryLastUserMessage(ctx, content);
      },
    });
  }

  const registerEditor = (name: string) =>
    pi.registerCommand(name, {
      description:
        "Configure ordered fallback models (Session / Current dir / Global)",
      handler: openEditor,
    });
  registerEditor("fallback");
  registerEditor("fallback-config");

  pi.registerCommand("fallback-status", {
    description: "Show ordered fallback models and their scope",
    handler: async (_args, ctx) => {
      refreshPersistentSettings(ctx);
      const settings = currentSettings();
      const effective = resolveEffectiveFallbacks(settings);
      const lines = [
        `[${EXTENSION_NAME}]`,
        `Current: ${modelRef(ctx.model) ?? "(none)"}`,
        `Session: ${settings.session === undefined ? "inherits" : settings.session.join(" → ") || "disabled"}`,
        `Current dir: ${settings.directory === undefined ? "inherits" : settings.directory.join(" → ") || "disabled"}`,
        `Global: ${settings.global === undefined ? "not configured" : settings.global.join(" → ") || "disabled"}`,
        `Effective (${sourceLabel(effective.source)}): ${effective.fallbacks.join(" → ") || "none"}`,
        `Consecutive failures: ${consecutiveFailures}/${RETRY_TOLERANCE}`,
        `Switch method: ${piSwitchAvailable() ? "pi-switch bus (direct setModel fallback)" : "direct setModel (pi-switch not detected)"}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}

// ponytail: keep the failure classifier small and deterministic; provider-specific adapters can be added only when real errors require them.
if (process.argv.includes("--selfcheck")) {
  const assert = (condition: boolean, message: string) => {
    if (!condition) throw new Error(`selfcheck failed: ${message}`);
  };
  assert(classifyError("429 rate limit") === "transient", "rate limit");
  assert(classifyError("Monthly usage limit reached") === "quota", "quota");
  assert(classifyError("404 model not found") === "unavailable", "not found");
  assert(
    classifyError("context length exceeded") === "ignore",
    "context overflow",
  );
  console.log("✓ pi-fallback selfcheck passed");
}
