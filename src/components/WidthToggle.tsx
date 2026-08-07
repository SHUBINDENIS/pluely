import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MoveHorizontalIcon } from "lucide-react";
import { safeLocalStorage } from "@/lib/storage";
import { STORAGE_KEYS, WINDOW_WIDTH_PRESETS, DEFAULT_WINDOW_WIDTH } from "@/config";

const readWidth = () => {
    const raw = safeLocalStorage.getItem(STORAGE_KEYS.WINDOW_WIDTH);
    const parsed = raw ? parseInt(raw, 10) : DEFAULT_WINDOW_WIDTH;
    return Number.isFinite(parsed) ? parsed : DEFAULT_WINDOW_WIDTH;
};

const applyWidth = async (width: number) => {
    try {
          await invoke("set_window_width", { width });
    } catch (error) {
          console.error("Failed to set window width:", error);
    }
};

export const WidthToggle = () => {
    useEffect(() => {
          const width = readWidth();
          if (width !== DEFAULT_WINDOW_WIDTH) {
                  applyWidth(width);
          }
    }, []);

    const cycle = async () => {
          const current = readWidth();
          const idx = WINDOW_WIDTH_PRESETS.indexOf(current as never);
          const next = WINDOW_WIDTH_PRESETS[(idx + 1) % WINDOW_WIDTH_PRESETS.length];
          safeLocalStorage.setItem(STORAGE_KEYS.WINDOW_WIDTH, String(next));
          await applyWidth(next);
    };

    return (
          <button
                  type="button"
                  onClick={cycle}
                  title="Shirina okna: uzkoe / obychnoe / shirokoe"
                  className="flex items-center justify-center h-8 w-8 rounded-md cursor-pointer hover:bg-secondary/40 transition-colors select-none shrink-0"
                >
                <MoveHorizontalIcon className="h-4 w-4 opacity-80" />
          </button>button>
        );
};
</button>
