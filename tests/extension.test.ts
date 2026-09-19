import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, mock, test } from "bun:test";

const agentDir = mkdtempSync(join(tmpdir(), "pi-fallback-test-"));
mkdirSync(join(agentDir, "extensions"), { recursive: true });
writeFileSync(
  join(agentDir, "extensions", "pi-fallback.json"),
  JSON.stringify({ fallbacks: ["test/model-b", "test/model-c"] }),
);

mock.module("@earendil-works/pi-coding-agent", () => ({
  CONFIG_DIR_NAME: ".pi",
  getAgentDir: () => agentDir,
}));
mock.module("@earendil-works/pi-tui", () => ({
  Input: class {},
  SelectList: class {},
  matchesKey: (data: string, key: string) =>
    data === key || (key === "enter" && data === "\n"),
  truncateToWidth: (text: string, width: number) => text.slice(0, width),
  visibleWidth: (text: string) => text.length,
}));

const { default: piFallbackExtension, classifyError } = await import("../src/extension.ts");

test("classifies provider quota messages", () => {
  expect(classifyError("You have hit your ChatGPT usage limit (Plus plan).")).toBe("quota");
  expect(classifyError("You exceeded your current quota; check your plan and billing details.")).toBe("quota");
  expect(classifyError("Your credit balance is too low to continue.")).toBe("quota");
});

test("does not classify context overflow token counts as transient", () => {
  expect(classifyError("prompt is too long: 250000 tokens > 200000 maximum")).toBe("ignore");
  expect(classifyError("HTTP 500 provider error")).toBe("transient");
});

test("tries configured fallbacks in exact order across repeated failures", async () => {
  const modelA = {
    provider: "test",
    id: "model-a",
    name: "Model A",
    contextWindow: 100_000,
  };
  const modelB = {
    provider: "test",
    id: "model-b",
    name: "Model B",
    contextWindow: 100_000,
  };
  const modelC = {
    provider: "test",
    id: "model-c",
    name: "Model C",
    contextWindow: 100_000,
  };
  const models = [modelA, modelB, modelC];
  let current = modelA;
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const notifications: string[] = [];
  const retries: any[] = [];
  const ctx: any = {
    get model() {
      return current;
    },
    mode: "print",
    hasUI: false,
    cwd: process.cwd(),
    scopedModels: [],
    isProjectTrusted: () => true,
    isIdle: () => false,
    getContextUsage: () => undefined,
    modelRegistry: {
      find: (provider: string, id: string) =>
        models.find((model) => model.provider === provider && model.id === id),
      getAvailable: () => models,
    },
    sessionManager: { getBranch: () => [] },
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus: () => {},
    },
  };
  const pi: any = {
    on: (event: string, handler: (event: any, ctx: any) => unknown) =>
      handlers.set(event, handler),
    registerCommand: () => {},
    setModel: async (model: any) => {
      const previous = current;
      current = model;
      await handlers.get("model_select")?.(
        {
          type: "model_select",
          model,
          previousModel: previous,
          source: "set",
        },
        ctx,
      );
      return true;
    },
    sendUserMessage: (content: any, options: any) =>
      retries.push({ content, options }),
    appendEntry: () => {},
  };

  piFallbackExtension(pi);
  await handlers.get("session_start")?.(
    { type: "session_start", reason: "startup" },
    ctx,
  );
  await handlers.get("message_end")?.(
    { message: { role: "user", content: "do the work", timestamp: 1 } },
    ctx,
  );

  const failed = (model: any) => ({
    type: "agent_end",
    willRetry: false,
    messages: [
      {
        role: "assistant",
        provider: model.provider,
        model: model.id,
        stopReason: "error",
        errorMessage: "429 rate limit",
        content: [],
      },
    ],
  });

  await handlers.get("agent_end")?.(failed(modelA), ctx);
  await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
  await handlers.get("agent_end")?.(failed(modelB), ctx);
  await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
  await handlers.get("agent_end")?.(failed(modelC), ctx);
  await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);

  expect(retries).toHaveLength(2);
  expect(retries.map((retry) => retry.options)).toEqual([
    { deliverAs: "followUp" },
    { deliverAs: "followUp" },
  ]);
  expect(current.id).toBe("model-c");
  expect(notifications.filter((message) => message.includes("→"))).toEqual([
    "[pi-fallback] test/model-a failed (transient) → test/model-b",
    "[pi-fallback] test/model-b failed (transient) → test/model-c",
  ]);
  expect(notifications.at(-1)).toContain("no usable fallback remains");

  // A successful built-in retry must cancel the extension fallback instead of
  // creating a duplicate request after agent_settled.
  await handlers.get("session_start")?.(
    { type: "session_start", reason: "reload" },
    ctx,
  );
  await handlers.get("message_end")?.(
    { message: { role: "user", content: "second prompt", timestamp: 2 } },
    ctx,
  );
  await handlers.get("agent_end")?.(failed(modelC), ctx);
  await handlers.get("message_end")?.(
    {
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [],
        timestamp: 3,
      },
    },
    ctx,
  );
  await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
  expect(retries).toHaveLength(2);

  // A goal/continuation that recovers on its own must NOT trigger a fallback:
  // the successful assistant turn clears failure state before agent_settled.
  await handlers.get("session_start")?.(
    { type: "session_start", reason: "reload" },
    ctx,
  );
  await handlers.get("message_end")?.(
    { message: { role: "user", content: "goal work", timestamp: 4 } },
    ctx,
  );
  await handlers.get("agent_end")?.(failed(modelC), ctx);
  await handlers.get("message_end")?.(
    { message: { role: "user", content: "goal continuation", timestamp: 5 } },
    ctx,
  );
  await handlers.get("message_end")?.(
    { message: { role: "assistant", stopReason: "stop", content: [], timestamp: 6 } },
    ctx,
  );
  await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
  expect(retries).toHaveLength(2);
  expect(current.id).toBe("model-c");
});

function createTriggerHarness(options?: {
  commands?: { name: string }[];
  onEmit?: (channel: string, data: any) => void;
  omitEvents?: boolean;
}) {
  const modelA = { provider: "test", id: "model-a", name: "Model A", contextWindow: 100_000 };
  const modelB = { provider: "test", id: "model-b", name: "Model B", contextWindow: 100_000 };
  const modelC = { provider: "test", id: "model-c", name: "Model C", contextWindow: 100_000 };
  const models = [modelA, modelB, modelC];
  const state = { current: modelA };
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const notifications: string[] = [];
  const retries: any[] = [];
  const busHandlers = new Map<string, (data: any) => void>();
  const ctx: any = {
    get model() {
      return state.current;
    },
    mode: "print",
    hasUI: false,
    cwd: process.cwd(),
    scopedModels: [],
    isProjectTrusted: () => true,
    isIdle: () => false,
    getContextUsage: () => undefined,
    modelRegistry: {
      find: (provider: string, id: string) =>
        models.find((model) => model.provider === provider && model.id === id),
      getAvailable: () => models,
    },
    sessionManager: { getBranch: () => [] },
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus: () => {},
    },
  };
  const pi: any = {
    on: (event: string, handler: (event: any, ctx: any) => unknown) =>
      handlers.set(event, handler),
    registerCommand: () => {},
    getCommands: () => options?.commands ?? [],
    events: options?.omitEvents
      ? undefined
      : {
          on: (channel: string, handler: (data: any) => void) => {
            busHandlers.set(channel, handler);
          },
          emit: (channel: string, data: any) => options?.onEmit?.(channel, data),
        },
    setModel: async (model: any) => {
      const previous = state.current;
      state.current = model;
      await handlers.get("model_select")?.(
        { type: "model_select", model, previousModel: previous, source: "set" },
        ctx,
      );
      return true;
    },
    sendUserMessage: (content: any, sendOptions: any) =>
      retries.push({ content, options: sendOptions }),
    appendEntry: () => {},
  };
  piFallbackExtension(pi);
  return { models, modelA, modelB, modelC, state, handlers, notifications, retries, busHandlers, ctx, pi };
}

async function startTriggerRun(harness: ReturnType<typeof createTriggerHarness>, content = "do the work") {
  await harness.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, harness.ctx);
  await harness.handlers.get("message_end")?.({ message: { role: "user", content, timestamp: 1 } }, harness.ctx);
}

const triggerFailed = (model: any, overrides: Record<string, unknown> = {}) => ({
  type: "agent_end",
  willRetry: false,
  messages: [
    {
      role: "assistant",
      provider: model.provider,
      model: model.id,
      stopReason: "error",
      errorMessage: "429 rate limit",
      content: [],
      ...overrides,
    },
  ],
});

test("holds fallback while Pi retries, then falls back on the third consecutive failure", async () => {
  const harness = createTriggerHarness();
  const { handlers, ctx, state, retries, notifications, modelA } = harness;
  await startTriggerRun(harness);

  for (let round = 0; round < 2; round++) {
    const event = triggerFailed(modelA);
    event.willRetry = true;
    await handlers.get("agent_end")?.(event, ctx);
    await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
    expect(state.current.id).toBe("model-a");
    expect(retries).toHaveLength(0);
  }

  const last = triggerFailed(modelA);
  last.willRetry = true;
  await handlers.get("agent_end")?.(last, ctx);
  await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
  expect(state.current.id).toBe("model-b");
  expect(retries).toHaveLength(1);
  expect(notifications.some((message) => message.includes("→ test/model-b"))).toBe(true);
});

test("defers to goal continuation but falls back after tolerance", async () => {
  const harness = createTriggerHarness();
  const { handlers, ctx, state, retries, modelA } = harness;
  await startTriggerRun(harness);

  for (let round = 0; round < 2; round++) {
    await handlers.get("agent_end")?.(triggerFailed(state.current), ctx);
    await handlers.get("message_end")?.(
      { message: { role: "user", content: `goal nudge ${round}`, timestamp: 10 + round } },
      ctx,
    );
    await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
    expect(state.current.id).toBe("model-a");
    expect(retries).toHaveLength(0);
  }

  await handlers.get("agent_end")?.(triggerFailed(modelA), ctx);
  await handlers.get("message_end")?.(
    { message: { role: "user", content: "goal nudge 2", timestamp: 12 } },
    ctx,
  );
  await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
  expect(state.current.id).toBe("model-b");
  expect(retries).toHaveLength(1);
});

test("treats non-cancel aborts as failures and ignores user cancels", async () => {
  const harness = createTriggerHarness();
  const { handlers, ctx, state, retries } = harness;
  await startTriggerRun(harness);

  await handlers.get("agent_end")?.(
    triggerFailed(state.current, { stopReason: "aborted", errorMessage: "stream ended before message_stop" }),
    ctx,
  );
  await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
  expect(state.current.id).toBe("model-b");
  expect(retries).toHaveLength(1);

  await handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, ctx);
  await handlers.get("message_end")?.(
    { message: { role: "user", content: "again", timestamp: 20 } },
    ctx,
  );
  await handlers.get("agent_end")?.(
    triggerFailed(state.current, { stopReason: "aborted", errorMessage: "Aborted" }),
    ctx,
  );
  await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
  expect(state.current.id).toBe("model-b");
  expect(retries).toHaveLength(1);
});

test("routes activation through pi-switch bus when detected", async () => {
  const emitted: { channel: string; data: any }[] = [];
  const harness = createTriggerHarness({
    commands: [{ name: "switch" }],
    onEmit: (channel, data) => emitted.push({ channel, data }),
  });
  const { handlers, ctx, state, retries, notifications, busHandlers, modelA } = harness;
  await startTriggerRun(harness);

  await handlers.get("agent_end")?.(triggerFailed(modelA), ctx);
  const settled = handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
  expect(emitted).toHaveLength(1);
  expect(emitted[0]?.channel).toBe("pi-switch:request");
  expect(emitted[0]?.data.model).toBe("test/model-b");
  expect(emitted[0]?.data.mode).toBe("deferred");
  busHandlers.get("pi-switch:switched")?.({ to: "test/model-b", via: "bus", noop: false });
  await settled;
  expect(retries).toHaveLength(1);
  expect(state.current.id).toBe("model-b");
  expect(notifications.some((message) => message.includes("→ test/model-b"))).toBe(true);
});

test("uses setModel when a switch command exists but the events bus does not", async () => {
  const harness = createTriggerHarness({
    commands: [{ name: "switch" }],
    omitEvents: true,
  });
  const { handlers, ctx, state, retries, modelA } = harness;
  await startTriggerRun(harness);

  await handlers.get("agent_end")?.(triggerFailed(modelA), ctx);
  await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
  expect(state.current.id).toBe("model-b");
  expect(retries).toHaveLength(1);
});
