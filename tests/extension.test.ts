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

  // A goal/continuation can append a user message and successful assistant turn
  // before the failed run reaches agent_settled. That must not erase fallback state.
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
  expect(retries).toHaveLength(3);
  expect(retries[2]?.content).toBe("goal work");
});
