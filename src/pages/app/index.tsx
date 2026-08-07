import { Card, Updater, DragButton, WidthToggle, CustomCursor, Button } from "@/components";
import {
  SystemAudio,
  Completion,
  AudioVisualizer,
  StatusIndicator,
} from "./components";
import { useApp } from "@/hooks";
import { useApp as useAppContext } from "@/contexts";
import { SparklesIcon } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { ErrorLayout } from "@/layouts";
import { getPlatform } from "@/lib";

const App = () => {
  const { isHidden, systemAudio } = useApp();
  const { customizable } = useAppContext();
  const platform = getPlatform();

  const openDashboard = async () => {
    try {
      await invoke("open_dashboard");
    } catch (error) {
      console.error("Failed to open dashboard:", error);
    }
  };

  useEffect(() => {
    const win: any = getCurrentWindow();
    // Edge/corner resize strips (Windows-like). Real OS resize via Tauri.
    const mkStrip = (css: string, dir: string) => {
      const d = document.createElement("div");
      d.setAttribute("data-no-drag", "true");
      d.style.cssText = "position:fixed;z-index:2147483647;" + css;
      d.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        win.startResizeDragging(dir).catch(() => undefined);
      });
      document.body.appendChild(d);
      return d;
    };
    const strips = [
      mkStrip("top:0;bottom:0;right:0;width:6px;cursor:ew-resize;", "East"),
      mkStrip("top:0;bottom:0;left:0;width:6px;cursor:ew-resize;", "West"),
      mkStrip("left:0;right:0;bottom:0;height:6px;cursor:ns-resize;", "South"),
      mkStrip("right:0;bottom:0;width:14px;height:14px;cursor:nwse-resize;", "SouthEast"),
      mkStrip("left:0;bottom:0;width:14px;height:14px;cursor:nesw-resize;", "SouthWest"),
    ];
    // Whole-top-bar drag with a small movement threshold so clicks on
    // buttons/inputs still work, but dragging anywhere empty moves the window.
    const bar = document.querySelector('[data-tauri-drag-region="true"]');
    let armed = false;
    let sx = 0;
    let sy = 0;
    const onDown = (e: any) => {
      if (e.button !== 0) return;
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, [contenteditable="true"], [data-no-drag]')) return;
      armed = true;
      sx = e.clientX;
      sy = e.clientY;
    };
    const onMove = (e: any) => {
      if (!armed) return;
      if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) < 6) return;
      armed = false;
      win.startDragging().catch(() => undefined);
    };
    const onUp = () => {
      armed = false;
    };
    bar?.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      strips.forEach((s) => s.remove());
      bar?.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  return (
    <ErrorBoundary
      fallbackRender={() => {
        return <ErrorLayout isCompact />;
      }}
      resetKeys={["app-error"]}
      onReset={() => {
        console.log("Reset");
      }}
    >
      <div
        className={`w-screen h-screen flex overflow-hidden justify-center items-start ${
          isHidden ? "hidden pointer-events-none" : ""
        }`}
      >
                <Card data-tauri-drag-region="true" className="w-full flex flex-row items-center gap-2 p-2">
          <SystemAudio {...systemAudio} />
          {systemAudio?.capturing ? (
            <div className="flex flex-row items-center gap-2 justify-between w-full">
              <div className="flex flex-1 items-center gap-2">
                <AudioVisualizer isRecording={systemAudio?.capturing} />
              </div>
              <div className="flex !w-fit items-center gap-2">
                <StatusIndicator
                  setupRequired={systemAudio.setupRequired}
                  error={systemAudio.error}
                  isProcessing={systemAudio.isProcessing}
                  isAIProcessing={systemAudio.isAIProcessing}
                  capturing={systemAudio.capturing}
                />
              </div>
            </div>
          ) : null}

          <div
            className={`${
              systemAudio?.capturing
                ? "hidden w-full fade-out transition-all duration-300"
                : "w-full flex flex-row gap-2 items-center"
            }`}
          >
            <Completion isHidden={isHidden} />
            <Button
              size={"icon"}
              className="cursor-pointer"
              title="Open Dev Space"
              onClick={openDashboard}
            >
              <SparklesIcon className="h-4 w-4" />
            </Button>
          </div>

          <Updater />
                  <WidthToggle />
          <DragButton />
        </Card>
        {customizable.cursor.type === "invisible" && platform !== "linux" ? (
          <CustomCursor />
        ) : null}
      </div>
    </ErrorBoundary>
  );
};

export default App;
