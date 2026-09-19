import { expect, test } from "bun:test";
import {
  fuzzyFilterModels,
  modelSearchText,
  normalizeChain,
  resolveEffectiveFallbacks,
  resolveScope,
  sameOptionalChain,
  splitModelRef,
  type FallbackSettings,
} from "../src/logic.ts";

const empty: FallbackSettings = {
  session: undefined,
  directory: undefined,
  global: undefined,
};

test("normalizes model refs without changing their order", () => {
  expect(
    normalizeChain([
      " openai/gpt-4o ",
      "openai/gpt-4o",
      { provider: "google", id: "gemini-2.5-flash" },
      "not-a-model",
    ]),
  ).toEqual(["openai/gpt-4o", "google/gemini-2.5-flash"]);
});

test("resolves session, directory, then global precedence", () => {
  expect(resolveEffectiveFallbacks(empty)).toEqual({
    fallbacks: [],
    source: "none",
  });
  expect(
    resolveEffectiveFallbacks({ ...empty, global: ["openai/gpt-4o"] }),
  ).toEqual({
    fallbacks: ["openai/gpt-4o"],
    source: "global",
  });
  expect(
    resolveEffectiveFallbacks({
      ...empty,
      global: ["openai/gpt-4o"],
      directory: ["google/gemini-2.5-flash"],
    }),
  ).toEqual({ fallbacks: ["google/gemini-2.5-flash"], source: "directory" });
  expect(
    resolveEffectiveFallbacks({
      ...empty,
      global: ["openai/gpt-4o"],
      directory: [],
      session: ["anthropic/claude-sonnet"],
    }),
  ).toEqual({ fallbacks: ["anthropic/claude-sonnet"], source: "session" });
});

test("an explicit empty scope disables inherited fallbacks", () => {
  expect(
    resolveScope(
      { ...empty, global: ["openai/gpt-4o"], directory: [] },
      "directory",
    ),
  ).toEqual({
    fallbacks: [],
    source: "directory",
  });
});

test("splits only the provider prefix", () => {
  expect(splitModelRef("openrouter/openai/gpt-4o")).toEqual({
    provider: "openrouter",
    id: "openai/gpt-4o",
  });
  expect(splitModelRef("invalid")).toBeUndefined();
});

test("compares optional chains", () => {
  expect(sameOptionalChain(undefined, undefined)).toBe(true);
  expect(sameOptionalChain([], undefined)).toBe(false);
  expect(sameOptionalChain(["a/b"], ["a/b"])).toBe(true);
});

test("model search text leads with provider like /model", () => {
  expect(
    modelSearchText({ provider: "openai", id: "gpt-4o", name: "GPT-4o" }),
  ).toBe("openai openai/gpt-4o openai gpt-4o GPT-4o");
});

test("fuzzy filter matches fragments out of order like /model search", () => {
  const items = [
    "openai/gpt-4o",
    "google/gemini-flash",
    "anthropic/claude-opus",
  ];
  expect(fuzzyFilterModels(items, "gpto", (item) => item)).toEqual([
    "openai/gpt-4o",
  ]);
  expect(fuzzyFilterModels(items, "google flash", (item) => item)).toEqual([
    "google/gemini-flash",
  ]);
  expect(fuzzyFilterModels(items, "", (item) => item)).toEqual(items);
  expect(fuzzyFilterModels(items, "zzz", (item) => item)).toEqual([]);
});
