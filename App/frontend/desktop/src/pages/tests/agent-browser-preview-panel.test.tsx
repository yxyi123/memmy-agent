// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemmyAgentWebSocketConnection, MemmyAgentWsEvent } from "../../api/memmy-agent-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { AgentBrowserPreviewPanel } from "../agent-browser-preview-panel.js";

describe("AgentBrowserPreviewPanel", () => {
  let container: HTMLDivElement;
  let root: Root;
  let receive: ((event: MemmyAgentWsEvent) => void) | null;
  let request: ReturnType<typeof vi.fn>;
  let unsubscribe: ReturnType<typeof vi.fn>;
  let connection: MemmyAgentWebSocketConnection;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    receive = null;
    request = vi.fn(() => crypto.randomUUID());
    unsubscribe = vi.fn();
    connection = {
      requestBrowserPreview: request,
      onChat: vi.fn((_chatId, handler) => {
        receive = handler;
        return unsubscribe;
      }),
    } as unknown as MemmyAgentWebSocketConnection;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  function render(running: boolean) {
    act(() => root.render(
      <I18nProvider language="zh-CN">
        <AgentBrowserPreviewPanel
          connection={connection}
          chatId="chat-a"
          connectionGeneration={2}
          connected
          activeTurnId={running ? "turn-a" : null}
          running={running}
          onClose={vi.fn()}
        />
      </I18nProvider>
    ));
  }

  it("shows only a matching frame and stops polling when hidden", () => {
    render(true);
    expect(request).toHaveBeenCalledTimes(1);
    const requestId = request.mock.results[0]!.value as string;
    act(() => receive?.({
      event: "browser_preview",
      chat_id: "chat-a",
      request_id: "old-request",
      connection_generation: 2,
      turn_id: "turn-a",
      status: "ready",
      image_data_url: "data:image/jpeg;base64,b2xk",
      session_id: "old",
      page_id: "old",
      sequence: 1,
    }));
    expect(container.querySelector("img")).toBeNull();
    act(() => receive?.({
      event: "browser_preview",
      chat_id: "chat-a",
      request_id: requestId,
      connection_generation: 2,
      turn_id: "turn-a",
      status: "ready",
      image_data_url: "data:image/jpeg;base64,bmV3",
      session_id: "session-a",
      page_id: "page-a",
      sequence: 1,
      url: "https://example.test/current",
      title: "Current page",
    }));
    expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,bmV3");
    act(() => vi.advanceTimersByTime(1_100));
    expect(request).toHaveBeenCalledTimes(2);
    const secondRequestId = request.mock.results[1]!.value as string;
    act(() => receive?.({
      event: "browser_preview",
      chat_id: "chat-a",
      request_id: secondRequestId,
      connection_generation: 2,
      turn_id: "turn-a",
      status: "ready",
      image_data_url: "data:image/jpeg;base64,c3RhbGU=",
      session_id: "session-a",
      page_id: "page-a",
      sequence: 0,
    }));
    expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,bmV3");
    act(() => root.unmount());
    act(() => vi.advanceTimersByTime(3_000));
    expect(request).toHaveBeenCalledTimes(2);
    expect(unsubscribe).toHaveBeenCalledOnce();
    root = createRoot(container);
  });

  it("requests one frame while idle without periodic capture", () => {
    render(false);
    expect(request).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(5_000));
    expect(request).toHaveBeenCalledOnce();
  });
});
