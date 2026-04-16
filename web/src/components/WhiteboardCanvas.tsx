import { useEffect, useRef, useCallback } from "react";
import { Excalidraw, exportToBlob, restoreElements } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type ExcalidrawImperativeAPI = any;
export type ExcalidrawElement = any;

interface Props {
  initialElements?: readonly ExcalidrawElement[];
  isFullscreen: boolean;
  onApiReady: (api: ExcalidrawImperativeAPI) => void;
  onChange?: () => void;
  onToggleFullscreen: () => void;
}

export { restoreElements };

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function exportBlob(api: ExcalidrawImperativeAPI, maxWidthOrHeight: number): Promise<Blob> {
  return exportToBlob({
    elements: api.getSceneElements(),
    appState: { ...api.getAppState(), exportWithDarkMode: false },
    files: api.getFiles(),
    maxWidthOrHeight,
    mimeType: "image/png",
  });
}

export async function exportCanvasPng(api: ExcalidrawImperativeAPI): Promise<string> {
  return blobToDataUrl(await exportBlob(api, 1024));
}

export async function exportThumbnail(api: ExcalidrawImperativeAPI): Promise<string> {
  if (api.getSceneElements().length === 0) return "";
  return blobToDataUrl(await exportBlob(api, 200));
}

export default function WhiteboardCanvas({
  initialElements,
  isFullscreen,
  onApiReady,
  onChange,
  onToggleFullscreen,
}: Props) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);

  const handleApiReady = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      apiRef.current = api;
      onApiReady(api);
    },
    [onApiReady],
  );

  useEffect(() => {
    if (apiRef.current && initialElements) {
      apiRef.current.updateScene({ elements: initialElements as ExcalidrawElement[] });
    }
  }, [initialElements]);

  return (
    <div
      className={isFullscreen ? "wb-canvas wb-canvas--fullscreen" : "wb-canvas"}
    >
      <button
        className="wb-canvas__fullscreen-btn"
        onClick={onToggleFullscreen}
        title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
      >
        {isFullscreen ? "\u2716" : "\u26F6"}
      </button>
      <div className="wb-canvas__inner">
        <Excalidraw
          excalidrawAPI={handleApiReady}
          initialData={initialElements ? { elements: initialElements as ExcalidrawElement[] } : undefined}
          onChange={onChange}
          theme="dark"
          UIOptions={{ welcomeScreen: false }}
        />
      </div>
    </div>
  );
}
