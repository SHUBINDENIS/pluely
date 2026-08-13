import { useState } from "react";
import {
  Button,
  Popover,
  PopoverTrigger,
  PopoverContent,
  ScrollArea,
} from "@/components";
import {
  HeadphonesIcon,
  AlertCircleIcon,
  LoaderIcon,
  AudioLinesIcon,
  CameraIcon,
  PlusIcon,
  PlayIcon,
  HistoryIcon,
  XIcon,
} from "lucide-react";
import { ModeSwitcher } from "./ModeSwitcher";
import { RecordingPanel } from "./RecordingPanel";
import { ResultsSection } from "./ResultsSection";
import { SettingsPanel } from "./SettingsPanel";
import { PermissionFlow } from "./PermissionFlow";
import { QuickActions } from "./QuickActions";
import { Warning } from "./Warning";
import { useSystemAudioType } from "@/hooks";
import { useApp } from "@/contexts";
import { cn } from "@/lib/utils";
import { SESSION_PRESETS } from "@/config";

export const SystemAudio = (props: useSystemAudioType) => {
  const {
    capturing,
    isProcessing,
    isAIProcessing,
    lastAIResponse,
    error,
    setupRequired,
    startCapture,
    stopCapture,
    pauseCapture,
    resumeCapture,
    paused,
    hideLevel,
    setHideLevel,
    screenshotImages,
    removeScreenshot,
    isCapturingScreenshot,
    captureScreenshot,
    isPopoverOpen,
    setIsPopoverOpen,
    useSystemPrompt,
    setUseSystemPrompt,
    contextContent,
    setContextContent,
    contextSize,
    setContextSize,
    compressOlder,
    setCompressOlder,
    unlimitedContext,
    setUnlimitedContext,
    startNewConversation,
    conversation,
    resizeWindow,
    quickActions,
    addQuickAction,
    removeQuickAction,
    isManagingQuickActions,
    setIsManagingQuickActions,
    showQuickActions,
    setShowQuickActions,
    handleQuickActionClick,
    submitText,
    pendingUserMessage,
    pastConversations,
    refreshPastConversations,
    loadConversation,
    sessionPresetId,
    setSessionPreset,
    vadConfig,
    updateVadConfiguration,
    accumulateMode,
    setAccumulateMode,
    accumulatedText,
    sendAccumulated,
    clearAccumulated,
    isRecordingInContinuousMode,
    recordingProgress,
    manualStopAndSend,
    startContinuousRecording,
    ignoreContinuousRecording,
    scrollAreaRef,
  } = props;

  const { hasActiveLicense, supportsImages } = useApp();

  // Typed question inside the voice chat
  const [textInput, setTextInput] = useState("");
  // In-window history browser
  const [showHistory, setShowHistory] = useState(false);

  const handleSubmitText = async () => {
    const value = textInput.trim();
    if (!value || isAIProcessing) return;
    setTextInput("");
    await submitText(value);
  };

  const toggleHistory = () => {
    setShowHistory((v) => {
      if (!v) refreshPastConversations();
      return !v;
    });
  };

  const isVadMode = vadConfig.enabled;
  const hasResponse =
    lastAIResponse || isAIProcessing || conversation.messages.length > 0;

  const handleToggleCapture = async () => {
    // If the dialog was hidden via Ctrl+\ , the leftmost button just re-opens
    // it (closing stays exclusively on Ctrl+\).
    if (hideLevel > 0) {
      setHideLevel(0);
      return;
    }
    if (capturing) {
      // Pause instead of stop: keeps the window open and preserves context.
      await pauseCapture();
    } else if (paused) {
      await resumeCapture();
    } else {
      // Continue the current chat if it already has messages (e.g. a session
      // opened from history); otherwise start a fresh one.
      await startCapture(conversation.messages.length > 0);
    }
  };

  const handleModeChange = (vadEnabled: boolean) => {
    updateVadConfiguration({
      ...vadConfig,
      enabled: vadEnabled,
    });
  };

  const getButtonIcon = () => {
    if (setupRequired) return <AlertCircleIcon className="text-orange-500" />;
    if (error && !setupRequired)
      return <AlertCircleIcon className="text-red-500" />;
    if (isProcessing) return <LoaderIcon className="animate-spin" />;
    if (capturing)
      return <AudioLinesIcon className="text-green-500 animate-pulse" />;
    if (paused) return <PlayIcon className="text-amber-500" />;
    return <HeadphonesIcon />;
  };

  const getButtonTitle = () => {
    if (setupRequired) return "Setup required - Click for instructions";
    if (error && !setupRequired) return `Error: ${error}`;
    if (isProcessing) return "Transcribing audio...";
    if (capturing) return "Пауза прослушивания (контекст сохранится)";
    if (paused)
      return "На паузе — продолжить прослушивание (контекст сохранён)";
    return "Начать прослушивание системного звука";
  };

  return (
    <Popover
      open={isPopoverOpen}
      onOpenChange={(open) => {
        if ((capturing || paused) && !open) {
          return;
        }
        setIsPopoverOpen(open);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          size="icon"
          title={getButtonTitle()}
          onClick={handleToggleCapture}
          className={cn(
            capturing && "bg-green-50 hover:bg-green-100",
            error && "bg-red-100 hover:bg-red-200"
          )}
        >
          {getButtonIcon()}
        </Button>
      </PopoverTrigger>

      {(capturing || paused || setupRequired || error) && (
        <PopoverContent
          align="end"
          side="bottom"
          className="select-none w-screen p-0 border shadow-lg overflow-hidden border-input/50"
          sideOffset={8}
        >
          <div className="flex flex-col h-[calc(100vh-4rem)] overflow-hidden">
            {/* Header - Mode Switcher + Actions */}
            <div className="flex-shrink-0 p-3 border-b border-border/50">
              <div className="flex items-center justify-between gap-2">
                {/* Mode Switcher */}
                {!setupRequired && (
                  <ModeSwitcher
                    isVadMode={isVadMode}
                    onModeChange={handleModeChange}
                    disabled={
                      isRecordingInContinuousMode ||
                      isProcessing ||
                      isAIProcessing
                    }
                  />
                )}
                {setupRequired && (
                  <h2 className="font-semibold text-sm">Нужна настройка</h2>
                )}

                {/* Action Buttons */}
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {/* Screenshot Button */}
                  {hasActiveLicense && !setupRequired && supportsImages && (
                    <Button
                      size="sm"
                      variant={screenshotImages.length ? "default" : "outline"}
                      onClick={captureScreenshot}
                      disabled={isCapturingScreenshot}
                      className={cn(
                        "h-6 text-[10px] gap-1 px-2",
                        screenshotImages.length &&
                          "bg-primary text-primary-foreground"
                      )}
                      title="Добавить скриншот к следующему вопросу (можно несколько; Ctrl+Shift+S — отправить сразу)"
                    >
                      {isCapturingScreenshot ? (
                        <LoaderIcon className="w-3 h-3 animate-spin" />
                      ) : (
                        <CameraIcon className="w-3 h-3" />
                      )}
                      Скриншот
                      {screenshotImages.length > 0 && (
                        <span className="ml-0.5 rounded-full bg-background/30 px-1 text-[9px] font-semibold">
                          {screenshotImages.length}
                        </span>
                      )}
                    </Button>
                  )}

                  {/* History Button */}
                  {!setupRequired && (
                    <Button
                      size="sm"
                      variant={showHistory ? "default" : "ghost"}
                      onClick={toggleHistory}
                      className="h-6 text-[10px] gap-1 px-2"
                      title="История прошлых сессий"
                    >
                      <HistoryIcon className="w-3 h-3" />
                      История
                    </Button>
                  )}

                  {/* New Conversation Button */}
                  {!setupRequired && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={startNewConversation}
                      className="h-6 text-[10px] gap-1 px-2"
                      title="Новая сессия (в этом же окне)"
                    >
                      <PlusIcon className="w-3 h-3" />
                      Новая
                    </Button>
                  )}

                  {/* Close Button */}
                  {!capturing && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6"
                      title={paused ? "Завершить сессию" : "Close"}
                      onClick={() => {
                        if (paused) {
                          // Fully end the session (audio already stopped).
                          stopCapture();
                        } else {
                          setIsPopoverOpen(false);
                          resizeWindow(false);
                        }
                      }}
                    >
                      <XIcon className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            </div>

            <ScrollArea className="flex-1 min-h-0" ref={scrollAreaRef}>
              <div className="p-2 space-y-2">
                {/* Screenshot Previews (queue) */}
                {screenshotImages.length > 0 && (
                  <div className="p-2 rounded-lg bg-primary/5 border border-primary/20 space-y-1.5">
                    <p className="text-[10px] font-medium">
                      Скриншотов прикреплено: {screenshotImages.length} — уйдут со
                      следующим вопросом
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {screenshotImages.map((img, i) => (
                        <div key={i} className="relative">
                          <img
                            src={`data:image/png;base64,${img}`}
                            alt={`Screenshot ${i + 1}`}
                            className="h-12 w-20 object-cover rounded border border-border/50"
                          />
                          <button
                            type="button"
                            data-no-drag="true"
                            onClick={() => removeScreenshot(i)}
                            className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-background border border-border flex items-center justify-center hover:bg-destructive hover:text-destructive-foreground"
                            title="Убрать этот скриншот"
                          >
                            <XIcon className="h-2.5 w-2.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Error Display */}
                {error && !setupRequired && (
                  <div className="flex items-start gap-2 p-2.5 rounded-lg bg-red-50 border border-red-200">
                    <AlertCircleIcon className="w-3.5 h-3.5 text-red-500 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-[10px] font-medium text-red-800">
                        Error
                      </p>
                      <p className="text-[10px] text-red-700">{error}</p>
                    </div>
                  </div>
                )}

                {/* Setup Required - Permission Flow */}
                {setupRequired ? (
                  <PermissionFlow
                    onPermissionGranted={() => {
                      startCapture();
                    }}
                    onPermissionDenied={() => {
                      // Keep showing setup instructions
                    }}
                  />
                ) : (
                  <>
                    {/* History browser (past sessions) */}
                    {showHistory && (
                      <div className="rounded-lg border border-border/50 bg-muted/20 p-2 space-y-1 max-h-[52vh] overflow-y-auto">
                        <div className="flex items-center justify-between px-1 pb-1">
                          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                            История сессий
                          </span>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-5 w-5"
                            onClick={() => setShowHistory(false)}
                          >
                            <XIcon className="h-3 w-3" />
                          </Button>
                        </div>
                        {pastConversations.length === 0 ? (
                          <p className="text-[10px] text-muted-foreground px-1 py-2">
                            Пока нет сохранённых сессий.
                          </p>
                        ) : (
                          pastConversations.map((c) => (
                            <button
                              key={c.id}
                              data-no-drag="true"
                              onClick={() => {
                                loadConversation(c.id);
                                setShowHistory(false);
                              }}
                              className="w-full text-left p-2 rounded-md hover:bg-secondary/50 transition-colors"
                            >
                              <div className="text-[11px] font-medium truncate">
                                {c.title || "Без названия"}
                              </div>
                              <div className="text-[9px] text-muted-foreground">
                                {c.messages.length} сообщ.
                              </div>
                            </button>
                          ))
                        )}
                      </div>
                    )}

                    {/* Session preset (system prompt) */}
                    <div className="flex items-center gap-2 px-1">
                      <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                        Пресет:
                      </span>
                      <select
                        data-no-drag="true"
                        value={sessionPresetId}
                        onChange={(e) => setSessionPreset(e.target.value)}
                        className="flex-1 h-7 px-2 text-[11px] rounded-md bg-background border border-input focus:outline-none focus:ring-1 focus:ring-ring"
                      >
                        {SESSION_PRESETS.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Type a question directly into the voice chat */}
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        handleSubmitText();
                      }}
                      className="flex items-center gap-1.5 px-1"
                    >
                      <input
                        data-no-drag="true"
                        value={textInput}
                        onChange={(e) => setTextInput(e.target.value)}
                        placeholder="Напишите вопрос сюда…"
                        disabled={isAIProcessing}
                        className="flex-1 h-8 px-2.5 text-xs rounded-md bg-background border border-input focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                      <Button
                        type="submit"
                        size="sm"
                        className="h-8 px-3 text-[10px]"
                        disabled={!textInput.trim() || isAIProcessing}
                      >
                        Отправить
                      </Button>
                    </form>

                    {/* Auto-detect: accumulate / send-on-demand control */}
                    {isVadMode && (
                      <div className="rounded-lg border border-border/50 bg-muted/30 p-3 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex-1">
                            <p className="text-xs font-medium">
                              Копить фразы перед отправкой
                            </p>
                            <p className="text-[10px] text-muted-foreground">
                              {accumulateMode
                                ? "Фразы копятся — отправьте, когда вопрос задан полностью"
                                : "Каждая фраза уходит сразу, как закончится"}
                            </p>
                          </div>
                          <button
                            type="button"
                            data-no-drag="true"
                            role="switch"
                            aria-checked={accumulateMode}
                            onClick={() => setAccumulateMode(!accumulateMode)}
                            className={cn(
                              "relative h-5 w-9 flex-shrink-0 rounded-full transition-colors",
                              accumulateMode ? "bg-primary" : "bg-muted-foreground/30"
                            )}
                          >
                            <span
                              className={cn(
                                "absolute top-0.5 h-4 w-4 rounded-full bg-background transition-transform",
                                accumulateMode ? "translate-x-4" : "translate-x-0.5"
                              )}
                            />
                          </button>
                        </div>

                        {accumulateMode && (
                          <div className="space-y-2">
                            <div className="rounded-md bg-background/60 border border-border/50 p-2 text-[11px] min-h-[2.5rem] max-h-24 overflow-y-auto">
                              {accumulatedText ? (
                                accumulatedText
                              ) : (
                                <span className="text-muted-foreground">
                                  Накопленный вопрос появится здесь…
                                </span>
                              )}
                            </div>
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                className="flex-1 h-7 text-[10px] gap-1"
                                onClick={clearAccumulated}
                                disabled={!accumulatedText || isAIProcessing}
                              >
                                <XIcon className="w-3 h-3" />
                                Очистить
                              </Button>
                              <Button
                                size="sm"
                                className="flex-1 h-7 text-[10px]"
                                onClick={sendAccumulated}
                                disabled={!accumulatedText || isAIProcessing}
                              >
                                Отправить вопрос
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Recording Panel */}
                    <RecordingPanel
                      isVadMode={isVadMode}
                      isRecording={isRecordingInContinuousMode}
                      isProcessing={isProcessing}
                      isAIProcessing={isAIProcessing}
                      recordingProgress={recordingProgress}
                      maxDuration={vadConfig.max_recording_duration_secs}
                      onStartRecording={startContinuousRecording}
                      onStopAndSend={manualStopAndSend}
                      onIgnore={ignoreContinuousRecording}
                    />

                    {/* Chat feed (voice + text + screenshots, with history) */}
                    <ResultsSection
                      lastAIResponse={lastAIResponse}
                      isAIProcessing={isAIProcessing}
                      conversation={conversation}
                      pendingUserMessage={pendingUserMessage}
                    />

                    {/* Settings Panel */}
                    <SettingsPanel
                      vadConfig={vadConfig}
                      onUpdateVadConfig={updateVadConfiguration}
                      useSystemPrompt={useSystemPrompt}
                      setUseSystemPrompt={setUseSystemPrompt}
                      contextContent={contextContent}
                      setContextContent={setContextContent}
                      contextSize={contextSize}
                      setContextSize={setContextSize}
                      compressOlder={compressOlder}
                      setCompressOlder={setCompressOlder}
                      unlimitedContext={unlimitedContext}
                      setUnlimitedContext={setUnlimitedContext}
                    />

                    {/* Help/Keyboard Shortcuts */}
                    <Warning isVadMode={isVadMode} />
                  </>
                )}
              </div>
            </ScrollArea>

            {/* Quick Actions */}
            {!setupRequired && hasResponse && (
              <div className="flex-shrink-0 border-t border-border/50 p-2">
                <QuickActions
                  actions={quickActions}
                  onActionClick={handleQuickActionClick}
                  onAddAction={addQuickAction}
                  onRemoveAction={removeQuickAction}
                  isManaging={isManagingQuickActions}
                  setIsManaging={setIsManagingQuickActions}
                  show={showQuickActions}
                  setShow={setShowQuickActions}
                />
              </div>
            )}
          </div>
        </PopoverContent>
      )}
    </Popover>
  );
};
