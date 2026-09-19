export type Scope = "session" | "directory" | "global";

export type ModelRef = string;

export interface FallbackSettings {
  session: ModelRef[] | undefined;
  directory: ModelRef[] | undefined;
  global: ModelRef[] | undefined;
}

export interface ResolvedFallbacks {
  fallbacks: ModelRef[];
  source: Scope | "none";
}

export function normalizeModelRef(value: unknown): ModelRef | undefined {
  if (typeof value === "string") {
    const ref = value.trim();
    const separator = ref.indexOf("/");
    if (separator > 0 && separator < ref.length - 1 && !/[\r\n\t ]/.test(ref))
      return ref;
    return undefined;
  }

  if (value && typeof value === "object") {
    const candidate = value as {
      provider?: unknown;
      id?: unknown;
      model?: unknown;
    };
    if (
      typeof candidate.provider === "string" &&
      typeof candidate.id === "string"
    ) {
      return normalizeModelRef(`${candidate.provider}/${candidate.id}`);
    }
    if (typeof candidate.model === "string")
      return normalizeModelRef(candidate.model);
  }

  return undefined;
}

export function normalizeChain(values: unknown): ModelRef[] {
  if (!Array.isArray(values)) return [];

  const seen = new Set<ModelRef>();
  const result: ModelRef[] = [];
  for (const value of values) {
    const ref = normalizeModelRef(value);
    if (ref && !seen.has(ref)) {
      seen.add(ref);
      result.push(ref);
    }
  }
  return result;
}

export function resolveScope(
  settings: FallbackSettings,
  scope: Scope,
): ResolvedFallbacks {
  if (settings[scope] !== undefined) {
    return { fallbacks: [...settings[scope]!], source: scope };
  }

  if (scope === "session") {
    if (settings.directory !== undefined)
      return { fallbacks: [...settings.directory], source: "directory" };
    if (settings.global !== undefined)
      return { fallbacks: [...settings.global], source: "global" };
    return { fallbacks: [], source: "none" };
  }

  if (scope === "directory" && settings.global !== undefined) {
    return { fallbacks: [...settings.global], source: "global" };
  }

  return { fallbacks: [], source: "none" };
}

export function resolveEffectiveFallbacks(
  settings: FallbackSettings,
): ResolvedFallbacks {
  return resolveScope(settings, "session");
}

export function splitModelRef(
  ref: ModelRef,
): { provider: string; id: string } | undefined {
  const separator = ref.indexOf("/");
  if (separator <= 0 || separator === ref.length - 1) return undefined;
  return { provider: ref.slice(0, separator), id: ref.slice(separator + 1) };
}

export function sameOptionalChain(
  a: ModelRef[] | undefined,
  b: ModelRef[] | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export interface ModelSearchItem {
  provider: string;
  id: string;
  name?: string;
}

// Same search text as Pi's /model selector: provider first so
// provider-prefixed queries rank before proxy-provider IDs.
export function modelSearchText(item: ModelSearchItem): string {
  const name = item.name ? ` ${item.name}` : "";
  return `${item.provider} ${item.provider}/${item.id} ${item.provider} ${item.id}${name}`;
}

function subsequenceScore(query: string, text: string): number | undefined {
  if (query.length === 0) return 0;
  if (query.length > text.length) return undefined;
  let queryIndex = 0;
  let score = 0;
  let lastMatch = -1;
  let run = 0;
  for (let i = 0; i < text.length && queryIndex < query.length; i++) {
    if (text[i] !== query[queryIndex]) continue;
    const boundary = i === 0 || /[\s\-_./:]/.test(text[i - 1]!);
    if (lastMatch === i - 1) {
      run++;
      score -= run * 5;
    } else {
      run = 0;
      if (lastMatch >= 0) score += (i - lastMatch - 1) * 2;
    }
    if (boundary) score -= 10;
    score += i * 0.1;
    lastMatch = i;
    queryIndex++;
  }
  if (queryIndex < query.length) return undefined;
  if (query === text) score -= 100;
  return score;
}

// ponytail: mirrors pi-tui fuzzyFilter (per-token subsequence, all tokens must
// match, best score first) without depending on the host Pi's pi-tui version;
// the picker prefers the real fuzzyFilter when the host exports it.
export function fuzzyFilterModels<T>(
  items: T[],
  query: string,
  getText: (item: T) => string,
): T[] {
  const tokens = query
    .trim()
    .split(/[\s/]+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return items;
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const text = getText(item).toLowerCase();
    let total = 0;
    let allMatch = true;
    for (const token of tokens) {
      const score = subsequenceScore(token.toLowerCase(), text);
      if (score === undefined) {
        allMatch = false;
        break;
      }
      total += score;
    }
    if (allMatch) scored.push({ item, score: total });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.map((entry) => entry.item);
}

// ponytail: the chain is intentionally linear; add weighted health scoring only if ordering needs to become adaptive.
