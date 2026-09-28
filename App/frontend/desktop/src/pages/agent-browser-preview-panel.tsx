import { useEffect, useRef, useState } from "react";
import { Globe2, X } from "lucide-react";
import type { MemmyAgentWebSocketConnection, MemmyAgentWsEvent } from "../api/memmy-agent-client.js";
import { useTranslation } from "../i18n/use-translation.js";

type BrowserPreviewFrame = {
  sessionId: string;
  pageId: string;
  sequence: number;
  url: string;
  title: string;
  imageDataUrl: string;
};

type AgentBrowserPreviewPanelProps = {
  connection: MemmyAgentWebSocketConnection | null;
  chatId: string;
  connectionGeneration: number;
  connected: boolean;
  activeTurnId: string | null;
  running: boolean;
  onClose: () => void;
};

const REQUEST_TIMEOUT_MS = 8_000;

export function AgentBrowserPreviewPanel({
  connection,
  chatId,
  connectionGeneration,
  connected,
  activeTurnId,
  running,
  onClose,
}: AgentBrowserPreviewPanelProps) {
  const { t } = useTranslation();
  const [frame, setFrame] = useState<BrowserPreviewFrame | null>(null);
  const [status, setStatus] = useState<"empty" | "loading" | "ready" | "error">("loading");
  const requestRef = useRef<{ id: string; sentAt: number } | null>(null);

  useEffect(() => {
    if (!connection || !connected) {
      requestRef.current = null;
      return;
    }
    let disposed = false;
    const receive = (event: MemmyAgentWsEvent) => {
      if (disposed || event.event !== "browser_preview" || event.request_id !== requestRef.current?.id
        || (event.turn_id ?? null) !== activeTurnId
        || event.connection_generation !== connectionGeneration) return;
      requestRef.current = null;
      const nextStatus = event.status;
      if (nextStatus === "empty") {
        setFrame(null);
        setStatus("empty");
      } else if (nextStatus === "loading") {
        setStatus("loading");
      } else if (nextStatus === "error") {
        setStatus("error");
      } else if (nextStatus === "ready"
        && typeof event.session_id === "string"
        && typeof event.page_id === "string"
        && typeof event.sequence === "number"
        && typeof event.image_data_url === "string"
        && event.image_data_url.startsWith("data:image/jpeg;base64,")) {
        const { session_id: sessionId, page_id: pageId, sequence, image_data_url: imageDataUrl } = event;
        setFrame((current) => current !== null
          && current.sessionId === sessionId
          && current.pageId === pageId
          && current.sequence > sequence
          ? current
          : {
              sessionId,
              pageId,
              sequence,
              url: typeof event.url === "string" ? event.url : "",
              title: typeof event.title === "string" ? event.title : "",
              imageDataUrl,
            });
        setStatus("ready");
      }
    };
    const unsubscribe = connection.onChat(chatId, receive);
    const request = () => {
      if (disposed) return;
      if (requestRef.current && Date.now() - requestRef.current.sentAt < REQUEST_TIMEOUT_MS) return;
      try {
        const id = connection.requestBrowserPreview(chatId, activeTurnId, connectionGeneration);
        requestRef.current = { id, sentAt: Date.now() };
      } catch {
        setStatus("error");
      }
    };
    request();
    const timer = running ? window.setInterval(request, 1_100) : null;
    return () => {
      disposed = true;
      requestRef.current = null;
      unsubscribe();
      if (timer !== null) window.clearInterval(timer);
    };
  }, [connection, chatId, connectionGeneration, connected, activeTurnId, running]);

  return (
    <aside className="agent-browser-preview-panel" aria-label={t("home.browserPreview.title")}>
      <header className="agent-browser-preview-panel__header">
        <h2><Globe2 size={16} aria-hidden="true" />{t("home.browserPreview.title")}</h2>
        <button type="button" aria-label={t("home.browserPreview.close")} title={t("home.browserPreview.close")}
          onClick={onClose}><X size={16} aria-hidden="true" /></button>
      </header>
      <div className="agent-browser-preview-panel__body">
        {frame ? (
          <>
            <div className="agent-browser-preview-panel__location">
              <strong title={frame.title}>{frame.title || t("home.browserPreview.untitled")}</strong>
              <span title={frame.url}>{frame.url}</span>
            </div>
            <img src={frame.imageDataUrl} alt={t("home.browserPreview.imageAlt")} draggable={false} />
          </>
        ) : (
          <p className="agent-browser-preview-panel__empty">{t("home.browserPreview.empty")}</p>
        )}
        {!connected ? <p className="agent-browser-preview-panel__status">{t("home.browserPreview.disconnected")}</p>
          : status === "loading" ? <p className="agent-browser-preview-panel__status">{t("home.browserPreview.loading")}</p>
          : status === "error" ? <p className="agent-browser-preview-panel__status">{t("home.browserPreview.error")}</p>
          : !running && frame ? <p className="agent-browser-preview-panel__status">{t("home.browserPreview.paused")}</p>
          : null}
      </div>
    </aside>
  );
}
