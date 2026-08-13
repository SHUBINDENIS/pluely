import { useState } from "react";
import {
  InfoIcon,
  ChevronDownIcon,
  KeyboardIcon,
  AudioWaveformIcon,
  MicIcon,
  CameraIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface WarningProps {
  isVadMode: boolean;
}

export const Warning = ({ isVadMode }: WarningProps) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const isMac = navigator.platform.toLowerCase().includes("mac");
  const modKey = isMac ? "⌘" : "Ctrl";

  return (
    <div className="rounded-lg border border-border/50 bg-muted/30 overflow-hidden">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <InfoIcon className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-xs font-medium">Помощь и горячие клавиши</span>
        </div>
        <ChevronDownIcon
          className={cn(
            "w-4 h-4 text-muted-foreground transition-transform",
            isExpanded && "rotate-180"
          )}
        />
      </button>

      {isExpanded && (
        <div className="px-3 pb-3 space-y-3">
          {/* Current Mode Info */}
          <div className="flex items-start gap-2 p-2 rounded-md bg-primary/5">
            {isVadMode ? (
              <AudioWaveformIcon className="w-4 h-4 text-primary mt-0.5" />
            ) : (
              <MicIcon className="w-4 h-4 text-primary mt-0.5" />
            )}
            <div>
              <p className="text-xs font-medium">
                {isVadMode ? "Режим автоопределения" : "Ручной режим"}
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                {isVadMode
                  ? "Речь распознаётся автоматически из системного звука. Как только кто-то говорит — фраза захватывается и распознаётся."
                  : "Управляй записью вручную кнопкой или горячими клавишами."}
              </p>
            </div>
          </div>

          {/* Keyboard Shortcuts */}
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <KeyboardIcon className="w-3 h-3 text-muted-foreground" />
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                Горячие клавиши
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-[10px]">
              <div className="flex items-center justify-between p-1.5 rounded bg-muted/50">
                <span className="text-muted-foreground">Прокрутка вниз</span>
                <kbd className="px-1.5 py-0.5 rounded bg-background border border-border font-mono">
                  ↓
                </kbd>
              </div>
              <div className="flex items-center justify-between p-1.5 rounded bg-muted/50">
                <span className="text-muted-foreground">Прокрутка вверх</span>
                <kbd className="px-1.5 py-0.5 rounded bg-background border border-border font-mono">
                  ↑
                </kbd>
              </div>
              {!isVadMode && (
                <>
                  <div className="flex items-center justify-between p-1.5 rounded bg-muted/50">
                    <span className="text-muted-foreground">Старт/Стоп</span>
                    <kbd className="px-1.5 py-0.5 rounded bg-background border border-border font-mono">
                      Enter
                    </kbd>
                  </div>
                  <div className="flex items-center justify-between p-1.5 rounded bg-muted/50">
                    <span className="text-muted-foreground">Начать запись</span>
                    <kbd className="px-1.5 py-0.5 rounded bg-background border border-border font-mono">
                      Space
                    </kbd>
                  </div>
                  <div className="flex items-center justify-between p-1.5 rounded bg-muted/50">
                    <span className="text-muted-foreground">Отменить</span>
                    <kbd className="px-1.5 py-0.5 rounded bg-background border border-border font-mono">
                      Esc
                    </kbd>
                  </div>
                </>
              )}
              <div className="flex items-center justify-between p-1.5 rounded bg-muted/50">
                <span className="text-muted-foreground">Показать/скрыть</span>
                <kbd className="px-1.5 py-0.5 rounded bg-background border border-border font-mono">
                  {modKey}+K
                </kbd>
              </div>
            </div>
          </div>

          {/* Screenshot Feature */}
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <CameraIcon className="w-3 h-3 text-muted-foreground" />
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                Скриншоты
              </span>
            </div>
            <div className="p-2 rounded-md bg-primary/5 text-[10px] text-muted-foreground space-y-1">
              <p>
                Кнопка «Скриншот» делает снимок экрана и прикрепляет его к
                следующему вопросу. Можно добавить несколько.
              </p>
              <p>
                ИИ получит и распознанный текст, и картинки — и ответит с учётом
                того, что у тебя на экране.
              </p>
              <p className="text-[9px] opacity-70">
                Скриншоты автоматически очищаются после отправки сообщения.
              </p>
            </div>
          </div>

          {/* Tips */}
          <div className="text-[10px] text-muted-foreground space-y-1 pt-2 border-t border-border/50">
            <p>
              <strong>Совет:</strong> Автоопределение удобно для работы без рук
              во время собеседования или экзамена.
            </p>
            <p>
              <strong>Совет:</strong> Ручной режим — когда нужен точный контроль
              над тем, что отправляется.
            </p>
            <p>
              <strong>Совет:</strong> Быстрые действия отправляют уточняющий
              запрос в один клик.
            </p>
            <p>
              <strong>Совет:</strong> Скриншот делится тем, что у тебя на экране,
              чтобы ответ был точнее.
            </p>
          </div>
        </div>
      )}
    </div>
  );
};
