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

// ponytail: the chain is intentionally linear; add weighted health scoring only if ordering needs to become adaptive.
