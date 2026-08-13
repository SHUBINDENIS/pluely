import { useEffect, useState, useCallback, useRef } from "react";
import { useWindowResize, useGlobalShortcuts } from ".";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useApp } from "@/contexts";
import { fetchSTT, fetchAIResponse } from "@/lib/functions";
import {
  DEFAULT_QUICK_ACTIONS,
  DEFAULT_SYSTEM_PROMPT,
  SESSION_PRESETS,
  SPEECH_TO_TEXT_PROVIDERS,
  STORAGE_KEYS,
} from "@/config";
import {
  safeLocalStorage,
  shouldUsePluelyAPI,
  generateConversationTitle,
  saveConversation,
  getAllConversations,
  getConversationById,
  CONVERSATION_SAVE_DEBOUNCE_MS,
  generateConversationId,
  generateMessageId,
} from "@/lib";
import { Message } from "@/types/completion";

// VAD Configuration interface matching Rust
export interface VadConfig {
  enabled: boolean;
  hop_size: number;
  sensitivity_rms: number;
  peak_threshold: number;
  silence_chunks: number;
  min_speech_chunks: number;
  pre_speech_chunks: number;
  noise_gate_threshold: number;
  max_recording_duration_secs: number;
}

// OPTIMIZED VAD defaults - matches backend exactly for perfect performance
const DEFAULT_VAD_CONFIG: VadConfig = {
  enabled: true,
  hop_size: 1024,
  sensitivity_rms: 0.012, // Much less sensitive - only real speech
  peak_threshold: 0.035, // Higher threshold - filters clicks/noise
  silence_chunks: 45, // ~1.0s of required silence
  min_speech_chunks: 7, // ~0.16s - captures short answers
  pre_speech_chunks: 12, // ~0.27s - enough to catch word start
  noise_gate_threshold: 0.003, // Stronger noise filtering
  max_recording_duration_secs: 180, // 3 minutes default
};

// Chat message interface (reusing from useCompletion)
interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
}

// Conversation interface (reusing from useCompletion)
export interface ChatConversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export type useSystemAudioType = ReturnType<typeof useSystemAudio>;

export function useSystemAudio() {
  const { resizeWindow } = useWindowResize();
  const globalShortcuts = useGlobalShortcuts();
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [paused, setPaused] = useState(false);
  // Ctrl+\ visibility cycle: 0 = all visible, 1 = dialog (popover) hidden but
  // small panel visible + freed area click-through, 2 = panel hidden too +
  // whole window click-through. Pressing Ctrl+\ cycles 0→1→2→0.
  const [hideLevel, setHideLevel] = useState<number>(0);
  // Multiple screenshots can be queued and sent together with the next question
  // (voice, typed, or hotkey). Held as an array of raw base64 PNG strings.
  const [screenshotImages, setScreenshotImagesState] = useState<string[]>([]);
  const [isCapturingScreenshot, setIsCapturingScreenshot] =
    useState<boolean>(false);
  // The user message currently being answered (voice transcription OR typed
  // text OR screenshot prompt) — shown in the feed while the answer streams.
  const [pendingUserMessage, setPendingUserMessage] = useState<string>("");
  // Past voice sessions for the in-window history browser.
  const [pastConversations, setPastConversations] = useState<ChatConversation[]>(
    []
  );
  // Selected session preset (system prompt). Persisted; read via a ref in the
  // async speech→AI flow so it's always current without re-subscribing.
  const [sessionPresetId, setSessionPresetIdState] = useState<string>(
    () => safeLocalStorage.getItem("session_preset_id") || SESSION_PRESETS[0].id
  );
  const presetPromptRef = useRef<string>(
    SESSION_PRESETS.find(
      (p) =>
        p.id ===
        (safeLocalStorage.getItem("session_preset_id") || SESSION_PRESETS[0].id)
    )?.prompt || ""
  );
  const [isProcessing, setIsProcessing] = useState(false);
  const [isAIProcessing, setIsAIProcessing] = useState(false);
  const [lastTranscription, setLastTranscription] = useState<string>("");
  const [lastAIResponse, setLastAIResponse] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [setupRequired, setSetupRequired] = useState<boolean>(false);
  const [quickActions, setQuickActions] = useState<string[]>([]);
  const [isManagingQuickActions, setIsManagingQuickActions] =
    useState<boolean>(false);
  const [showQuickActions, setShowQuickActions] = useState<boolean>(true);
  const [vadConfig, setVadConfig] = useState<VadConfig>(DEFAULT_VAD_CONFIG);
  // Accumulate mode (auto-detect): instead of sending each detected phrase to
  // the AI immediately, buffer phrases so the speaker can finish a multi-part
  // question, then send on demand. Refs mirror state for the async listener.
  const [accumulateMode, setAccumulateModeState] = useState<boolean>(false);
  const [accumulatedText, setAccumulatedTextState] = useState<string>("");
  const accumulateModeRef = useRef<boolean>(false);
  const accumulatedTextRef = useRef<string>("");
  const [recordingProgress, setRecordingProgress] = useState<number>(0); // For continuous mode
  const [isContinuousMode, setIsContinuousMode] = useState<boolean>(false);
  const [isRecordingInContinuousMode, setIsRecordingInContinuousMode] =
    useState<boolean>(false);

  const [conversation, setConversation] = useState<ChatConversation>({
    id: "",
    title: "",
    messages: [],
    createdAt: 0,
    updatedAt: 0,
  });

  // Context management states
  const [useSystemPrompt, setUseSystemPrompt] = useState<boolean>(true);
  const [contextContent, setContextContent] = useState<string>("");
  // How many most-recent messages are kept verbatim in the AI context. Older
  // messages beyond this are either dropped or folded into a compact local
  // digest (see compressOlder) so long sessions stay cheap.
  const [contextSize, setContextSizeState] = useState<number>(50);
  const [compressOlder, setCompressOlderState] = useState<boolean>(true);
  // Unlimited context: send the ENTIRE session history verbatim (for solving a
  // long case without losing anything). Overrides contextSize/compression.
  const [unlimitedContext, setUnlimitedContextState] = useState<boolean>(false);
  // Refs so the async speech→AI flow reads current values without re-subscribing.
  const contextSizeRef = useRef<number>(50);
  const compressOlderRef = useRef<boolean>(true);
  const unlimitedContextRef = useRef<boolean>(false);

  const {
    selectedSttProvider,
    allSttProviders,
    selectedAIProvider,
    allAiProviders,
    systemPrompt,
    selectedAudioDevices,
  } = useApp();
  const abortControllerRef = useRef<AbortController | null>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isSavingRef = useRef<boolean>(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  // Mirror the queued screenshots in a ref so the async speech→STT→AI flow
  // (a Tauri event listener) always reads the latest value, not a stale closure.
  const screenshotImagesRef = useRef<string[]>([]);
  // Ref to the latest "capture screenshot and submit" action, so the global
  // screenshot-hotkey handler is registered ONCE and never churns/de-registers.
  const captureAndSubmitRef = useRef<() => Promise<void>>(async () => {});
  // Mirror "a recording is active" for the speech-detected listener, whose
  // effect closure would otherwise capture a stale isContinuousMode and could
  // drop a manual Stop & Send result.
  const recordingActiveRef = useRef<boolean>(false);
  // Mirror continuous(manual)-mode so the speech-detected listener never applies
  // accumulate buffering to a manual Stop & Send (accumulate is VAD-only).
  const isContinuousModeRef = useRef<boolean>(false);
  // Derives an STT provider from the selected AI provider's key when no STT
  // provider is configured — so Groq/OpenAI users get working voice without a
  // separate STT setup (their AI key also works for Whisper on the same host).
  const deriveSttRef = useRef<
    () => { provider: any; selectedProvider: any } | null
  >(() => null);

  // Load context settings and VAD config from localStorage on mount
  useEffect(() => {
    const savedContext = safeLocalStorage.getItem(
      STORAGE_KEYS.SYSTEM_AUDIO_CONTEXT
    );
    if (savedContext) {
      try {
        const parsed = JSON.parse(savedContext);
        setUseSystemPrompt(parsed.useSystemPrompt ?? true);
        setContextContent(parsed.contextContent ?? "");
        if (typeof parsed.contextSize === "number") {
          setContextSizeState(parsed.contextSize);
          contextSizeRef.current = parsed.contextSize;
        }
        if (typeof parsed.compressOlder === "boolean") {
          setCompressOlderState(parsed.compressOlder);
          compressOlderRef.current = parsed.compressOlder;
        }
        if (typeof parsed.unlimitedContext === "boolean") {
          setUnlimitedContextState(parsed.unlimitedContext);
          unlimitedContextRef.current = parsed.unlimitedContext;
        }
      } catch (error) {
        console.error("Failed to load system audio context:", error);
      }
    }

    // Load VAD config
    const savedVadConfig = safeLocalStorage.getItem("vad_config");
    if (savedVadConfig) {
      try {
        const parsed = JSON.parse(savedVadConfig);
        setVadConfig(parsed);
      } catch (error) {
        console.error("Failed to load VAD config:", error);
      }
    }
  }, []);

  // Load quick actions from localStorage on mount
  useEffect(() => {
    // One-time reseed to the new task-oriented defaults so existing installs
    // replace the old English presets. Runs once; afterwards the user's own
    // edits are respected.
    const QA_SEED_KEY = "quick_actions_seed_v2";
    if (safeLocalStorage.getItem(QA_SEED_KEY) !== "true") {
      setQuickActions(DEFAULT_QUICK_ACTIONS);
      safeLocalStorage.setItem(
        STORAGE_KEYS.SYSTEM_AUDIO_QUICK_ACTIONS,
        JSON.stringify(DEFAULT_QUICK_ACTIONS)
      );
      safeLocalStorage.setItem(QA_SEED_KEY, "true");
      return;
    }

    const savedActions = safeLocalStorage.getItem(
      STORAGE_KEYS.SYSTEM_AUDIO_QUICK_ACTIONS
    );
    if (savedActions) {
      try {
        const parsed = JSON.parse(savedActions);
        setQuickActions(parsed);
      } catch (error) {
        console.error("Failed to load quick actions:", error);
        setQuickActions(DEFAULT_QUICK_ACTIONS);
      }
    } else {
      setQuickActions(DEFAULT_QUICK_ACTIONS);
    }
  }, []);

  // Handle continuous recording progress events AND error events
  useEffect(() => {
    let progressUnlisten: (() => void) | undefined;
    let startUnlisten: (() => void) | undefined;
    let stopUnlisten: (() => void) | undefined;
    let errorUnlisten: (() => void) | undefined;
    let discardedUnlisten: (() => void) | undefined;

    const setupContinuousListeners = async () => {
      try {
        // Progress updates (every second)
        progressUnlisten = await listen("recording-progress", (event) => {
          const seconds = event.payload as number;
          setRecordingProgress(seconds);
        });

        // Recording started
        startUnlisten = await listen("continuous-recording-start", () => {
          setRecordingProgress(0);
          setIsRecordingInContinuousMode(true);
        });

        // Recording stopped
        stopUnlisten = await listen("continuous-recording-stopped", () => {
          setRecordingProgress(0);
          setIsRecordingInContinuousMode(false);
        });

        // Audio encoding errors
        errorUnlisten = await listen("audio-encoding-error", (event) => {
          const errorMsg = event.payload as string;
          console.error("Audio encoding error:", errorMsg);
          setError(`Failed to process audio: ${errorMsg}`);
          setIsProcessing(false);
          setIsAIProcessing(false);
          setIsRecordingInContinuousMode(false);
        });

        // Speech discarded (too short)
        discardedUnlisten = await listen("speech-discarded", (event) => {
          const reason = event.payload as string;
          console.log("Speech discarded:", reason);
          // Don't show error - this is expected behavior
        });
      } catch (err) {
        console.error("Failed to setup continuous recording listeners:", err);
      }
    };

    setupContinuousListeners();

    return () => {
      if (progressUnlisten) progressUnlisten();
      if (startUnlisten) startUnlisten();
      if (stopUnlisten) stopUnlisten();
      if (errorUnlisten) errorUnlisten();
      if (discardedUnlisten) discardedUnlisten();
    };
  }, []);

  // Drive the manual-recording progress from a wall-clock timer while a
  // continuous recording is active. The backend only emits "recording-progress"
  // as audio samples arrive, so during initial silence (or a loopback backend
  // that stays quiet until sound plays) the counter would sit at "Recording 0s"
  // and look broken. A JS timer guarantees the elapsed time is always visible.
  useEffect(() => {
    if (!isRecordingInContinuousMode) return;
    const startedAt = Date.now();
    setRecordingProgress(0);
    const id = setInterval(() => {
      setRecordingProgress(Math.floor((Date.now() - startedAt) / 1000));
    }, 500);
    return () => clearInterval(id);
  }, [isRecordingInContinuousMode]);

  // Keep the recording-active ref current for the speech-detected listener.
  useEffect(() => {
    recordingActiveRef.current =
      capturing || isContinuousMode || isRecordingInContinuousMode;
    isContinuousModeRef.current = isContinuousMode;
  }, [capturing, isContinuousMode, isRecordingInContinuousMode]);

  // Keep the AI→STT derivation current (reads latest AI provider + key).
  useEffect(() => {
    deriveSttRef.current = () => {
      const aiProv = allAiProviders.find(
        (p) => p.id === selectedAIProvider.provider
      );
      if (!aiProv) return null;
      const curl = String((aiProv as any).curl || "");
      const vars = (selectedAIProvider.variables || {}) as Record<
        string,
        string
      >;
      // The AI provider's API key (Groq keys start with gsk_, OpenAI with sk-).
      const key =
        vars.API_KEY ||
        vars.api_key ||
        (Object.values(vars).find((v) =>
          /^(gsk_|sk-)/.test(String(v || ""))
        ) as string | undefined);
      if (!key) return null;

      const isGroq =
        curl.includes("api.groq.com") || selectedAIProvider.provider === "groq";
      const isOpenAI =
        curl.includes("api.openai.com") ||
        selectedAIProvider.provider === "openai";

      if (isGroq) {
        const tpl = SPEECH_TO_TEXT_PROVIDERS.find((p) => p.id === "groq");
        if (!tpl) return null;
        return {
          provider: tpl,
          selectedProvider: {
            provider: "groq",
            variables: { API_KEY: key, MODEL: "whisper-large-v3-turbo" },
          },
        };
      }
      if (isOpenAI) {
        const tpl = SPEECH_TO_TEXT_PROVIDERS.find(
          (p) => p.id === "openai-whisper"
        );
        if (!tpl) return null;
        return {
          provider: tpl,
          selectedProvider: {
            provider: "openai-whisper",
            variables: { API_KEY: key, MODEL: "whisper-1" },
          },
        };
      }
      return null;
    };
  }, [selectedAIProvider, allAiProviders]);

  // Handle single speech detection event (both VAD and continuous modes)
  useEffect(() => {
    let speechUnlisten: (() => void) | undefined;

    const setupEventListener = async () => {
      try {
        speechUnlisten = await listen("speech-detected", async (event) => {
          try {
            // Accept the audio if we're capturing OR a manual recording is
            // active (ref avoids a stale-closure drop of Stop & Send results).
            if (!capturing && !recordingActiveRef.current) return;

            const base64Audio = event.payload as string;
            // Convert to blob
            const binaryString = atob(base64Audio);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            const audioBlob = new Blob([bytes], { type: "audio/wav" });

            const usePluelyAPI = await shouldUsePluelyAPI();

            // Resolve which STT provider to use. Priority: a configured STT
            // provider → Pluely API → an STT derived from the AI provider's key
            // (Groq/OpenAI). Only error if none of these are available.
            let providerConfig: any = selectedSttProvider.provider
              ? allSttProviders.find(
                  (p) => p.id === selectedSttProvider.provider
                )
              : undefined;
            let sttSelected: any = selectedSttProvider;

            if (!usePluelyAPI && !providerConfig) {
              const derived = deriveSttRef.current();
              if (derived) {
                providerConfig = derived.provider;
                sttSelected = derived.selectedProvider;
              } else {
                setError(
                  "Нет провайдера распознавания речи. Открой Dev Space → STT и добавь Groq/OpenAI Whisper с API-ключом (или включи Pluely API)."
                );
                return;
              }
            }

            setIsProcessing(true);

            // Add timeout wrapper for STT request (30 seconds)
            const sttPromise = fetchSTT({
              provider: providerConfig,
              selectedProvider: sttSelected,
              audio: audioBlob,
            });

            const timeoutPromise = new Promise<string>((_, reject) => {
              setTimeout(
                () => reject(new Error("Speech transcription timed out (30s)")),
                30000
              );
            });

            try {
              const transcription = await Promise.race([
                sttPromise,
                timeoutPromise,
              ]);

              // Guard: fetchSTT can RETURN (not throw) sentinel strings for
              // failed/empty segments. Don't feed those to the AI as a question.
              const t = transcription.trim();
              const looksLikeSttError =
                /^(No transcription found|Transcription failed|Pluely STT Error|Network error:|HTTP \d)/i.test(
                  t
                ) || /STT Error:/i.test(t);

              if (t && !looksLikeSttError) {
                setLastTranscription(transcription);
                setError("");

                // Accumulate mode (VAD only): buffer the phrase instead of
                // sending, so the speaker can finish a multi-part question. The
                // user sends the batch manually (sendAccumulated). Recording
                // keeps running. Never applies to a manual Stop & Send.
                if (accumulateModeRef.current && !isContinuousModeRef.current) {
                  const next = `${accumulatedTextRef.current} ${transcription}`.trim();
                  accumulatedTextRef.current = next;
                  setAccumulatedTextState(next);
                } else {
                  const effectiveSystemPrompt = useSystemPrompt
                    ? presetPromptRef.current ||
                      systemPrompt ||
                      DEFAULT_SYSTEM_PROMPT
                    : contextContent || DEFAULT_SYSTEM_PROMPT;

                  const previousMessages = conversation.messages.map((msg) => {
                    return { role: msg.role, content: msg.content };
                  });

                  await processWithAI(
                    transcription,
                    effectiveSystemPrompt,
                    previousMessages
                  );
                }
              } else {
                // Empty/near-silent segment (common in VAD). Ignore silently
                // instead of flashing an error on nearly every phrase.
                console.debug("Empty transcription — ignored");
              }
            } catch (sttError: any) {
              console.error("STT Error:", sttError);
              setError(sttError.message || "Failed to transcribe audio");
              setIsPopoverOpen(true);
            }
          } catch (err) {
            setError("Failed to process speech");
          } finally {
            setIsProcessing(false);
          }
        });
      } catch (err) {
        setError("Failed to setup speech listener");
      }
    };

    setupEventListener();

    return () => {
      if (speechUnlisten) speechUnlisten();
    };
  }, [
    capturing,
    selectedSttProvider,
    allSttProviders,
    conversation.messages.length,
  ]);

  // Context management functions. Persists all context settings together;
  // contextSize/compressOlder are read from refs so any single setter saves the
  // full, current set.
  const saveContextSettings = useCallback(
    (usePrompt: boolean, content: string) => {
      try {
        const contextSettings = {
          useSystemPrompt: usePrompt,
          contextContent: content,
          contextSize: contextSizeRef.current,
          compressOlder: compressOlderRef.current,
          unlimitedContext: unlimitedContextRef.current,
        };
        safeLocalStorage.setItem(
          STORAGE_KEYS.SYSTEM_AUDIO_CONTEXT,
          JSON.stringify(contextSettings)
        );
      } catch (error) {
        console.error("Failed to save context settings:", error);
      }
    },
    []
  );

  const updateUseSystemPrompt = useCallback(
    (value: boolean) => {
      setUseSystemPrompt(value);
      saveContextSettings(value, contextContent);
    },
    [contextContent, saveContextSettings]
  );

  const updateContextContent = useCallback(
    (content: string) => {
      setContextContent(content);
      saveContextSettings(useSystemPrompt, content);
    },
    [useSystemPrompt, saveContextSettings]
  );

  const setContextSize = useCallback(
    (value: number) => {
      const clamped = Math.max(5, Math.min(100, Math.round(value)));
      contextSizeRef.current = clamped;
      setContextSizeState(clamped);
      saveContextSettings(useSystemPrompt, contextContent);
    },
    [useSystemPrompt, contextContent, saveContextSettings]
  );

  const setCompressOlder = useCallback(
    (value: boolean) => {
      compressOlderRef.current = value;
      setCompressOlderState(value);
      saveContextSettings(useSystemPrompt, contextContent);
    },
    [useSystemPrompt, contextContent, saveContextSettings]
  );

  const setUnlimitedContext = useCallback(
    (value: boolean) => {
      unlimitedContextRef.current = value;
      setUnlimitedContextState(value);
      saveContextSettings(useSystemPrompt, contextContent);
    },
    [useSystemPrompt, contextContent, saveContextSettings]
  );

  // Fold older (beyond-window) messages into a compact, local digest — no extra
  // API call, so long sessions stay cheap. `older` is newest-first; we reverse
  // to chronological, truncate each turn, and cap the whole digest.
  const buildOlderDigest = useCallback((older: Message[]): string => {
    if (!older.length) return "";
    const PER_MSG = 220; // chars kept per message
    const MAX_DIGEST = 4000; // overall cap (~1k tokens)
    const chrono = [...older].reverse();
    const lines: string[] = [];
    for (const m of chrono) {
      const who = m.role === "assistant" ? "Ассистент" : "Пользователь";
      const text = String(m.content)
        .replace(/!\[[^\]]*\]\(data:[^)]*\)/g, "[скриншот]")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) continue;
      const clipped =
        text.length > PER_MSG ? text.slice(0, PER_MSG) + "…" : text;
      lines.push(`${who}: ${clipped}`);
    }
    let digest = lines.join("\n");
    if (digest.length > MAX_DIGEST) {
      // Keep the most recent of the older block (end of the digest).
      digest = "…" + digest.slice(digest.length - MAX_DIGEST);
    }
    return digest;
  }, []);

  // Quick actions management
  const saveQuickActions = useCallback((actions: string[]) => {
    try {
      safeLocalStorage.setItem(
        STORAGE_KEYS.SYSTEM_AUDIO_QUICK_ACTIONS,
        JSON.stringify(actions)
      );
    } catch (error) {
      console.error("Failed to save quick actions:", error);
    }
  }, []);

  const addQuickAction = useCallback(
    (action: string) => {
      if (action && !quickActions.includes(action)) {
        const newActions = [...quickActions, action];
        setQuickActions(newActions);
        saveQuickActions(newActions);
      }
    },
    [quickActions, saveQuickActions]
  );

  const removeQuickAction = useCallback(
    (action: string) => {
      const newActions = quickActions.filter((a) => a !== action);
      setQuickActions(newActions);
      saveQuickActions(newActions);
    },
    [quickActions, saveQuickActions]
  );

  const handleQuickActionClick = async (action: string) => {
    setError("");

    const effectiveSystemPrompt = useSystemPrompt
      ? presetPromptRef.current || systemPrompt || DEFAULT_SYSTEM_PROMPT
      : contextContent || DEFAULT_SYSTEM_PROMPT;

    // Include the most recent transcription in conversation history if it exists
    let updatedMessages = [...conversation.messages];

    if (lastTranscription && lastTranscription.trim()) {
      const lastMessage = updatedMessages[updatedMessages.length - 1];
      // Only add if it's not already the last message
      if (!lastMessage || lastMessage.content !== lastTranscription) {
        const timestamp = Date.now();
        const userMessage = {
          id: generateMessageId("user", timestamp),
          role: "user" as const,
          content: lastTranscription,
          timestamp,
        };
        updatedMessages.push(userMessage);

        // Update conversation state with the latest transcription
        setConversation((prev) => ({
          ...prev,
          messages: [userMessage, ...prev.messages],
          updatedAt: timestamp,
          title: prev.title || generateConversationTitle(lastTranscription),
        }));
      }
    }

    const previousMessages = updatedMessages.map((msg) => {
      return { role: msg.role, content: msg.content };
    });

    await processWithAI(action, effectiveSystemPrompt, previousMessages);
  };

  // Start continuous recording manually
  const startContinuousRecording = useCallback(async () => {
    try {
      setRecordingProgress(0);
      setError("");

      // Clean up any stale/prior capture task first (mirrors the VAD path).
      // Without this a leftover stream_task makes the backend reject the new
      // capture with "Capture already running", so the manual recording never
      // starts and the timer sits at "Recording 0s".
      try {
        await invoke<string>("stop_system_audio_capture");
      } catch {
        /* no active capture to stop — expected on a clean start */
      }

      const deviceId =
        selectedAudioDevices.output.id !== "default"
          ? selectedAudioDevices.output.id
          : null;

      // Manual recording must always run the continuous (non-VAD) backend path,
      // regardless of the persisted vadConfig.enabled flag, so force it here.
      const continuousConfig = { ...vadConfig, enabled: false };

      // Start a new continuous recording session
      await invoke<string>("start_system_audio_capture", {
        vadConfig: continuousConfig,
        deviceId: deviceId,
      });
    } catch (err) {
      console.error("Failed to start continuous recording:", err);
      setError(`Failed to start recording: ${err}`);
    }
  }, [vadConfig, selectedAudioDevices.output.id]);

  // Ignore current recording (stop without transcription)
  const ignoreContinuousRecording = useCallback(async () => {
    try {
      if (!isContinuousMode || !isRecordingInContinuousMode) return;

      // Stop the capture without processing
      await invoke<string>("stop_system_audio_capture");

      // Reset states
      setRecordingProgress(0);
      setIsProcessing(false);
      setIsRecordingInContinuousMode(false);
    } catch (err) {
      console.error("Failed to ignore recording:", err);
      setError(`Failed to ignore recording: ${err}`);
    }
  }, [isContinuousMode, isRecordingInContinuousMode]);

  // Screenshot queue helpers: keep state and ref in sync so images can be
  // attached to the next question (see processWithAI) and shown in the UI.
  const addScreenshot = useCallback((value: string) => {
    const next = [...screenshotImagesRef.current, value];
    screenshotImagesRef.current = next;
    setScreenshotImagesState(next);
  }, []);
  const removeScreenshot = useCallback((index: number) => {
    const next = screenshotImagesRef.current.filter((_, i) => i !== index);
    screenshotImagesRef.current = next;
    setScreenshotImagesState(next);
  }, []);
  const clearScreenshots = useCallback(() => {
    screenshotImagesRef.current = [];
    setScreenshotImagesState([]);
  }, []);

  const captureScreenshot = useCallback(async () => {
    if (isCapturingScreenshot) return;
    setIsCapturingScreenshot(true);
    try {
      const platform = navigator.platform.toLowerCase();
      if (platform.includes("mac")) {
        const {
          checkScreenRecordingPermission,
          requestScreenRecordingPermission,
        } = await import("tauri-plugin-macos-permissions-api");
        const hasPermission = await checkScreenRecordingPermission();
        if (!hasPermission) {
          await requestScreenRecordingPermission();
          setIsCapturingScreenshot(false);
          return;
        }
      }
      // NOTE: the correct Tauri command is "capture_to_base64" (the same one
      // the Ask box uses). The previous "capture_screenshot" command does not
      // exist in the Rust backend, so every capture silently failed.
      const base64 = (await invoke("capture_to_base64")) as string;
      if (!base64) {
        setError("Не удалось сделать снимок экрана (пустой результат).");
        return;
      }
      addScreenshot(base64);
    } catch (err) {
      console.error("Failed to capture screenshot:", err);
      setError(
        "Ошибка снимка экрана: " +
          (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setIsCapturingScreenshot(false);
    }
  }, [isCapturingScreenshot, addScreenshot]);

  // Remove base64 data-URL images from message content before sending history
  // to the API, so screenshots are never re-sent as text (keeps token cost
  // bounded — an image is only ever sent once, on the turn it was added).
  const stripDataUrlImages = (content: string): string =>
    typeof content === "string"
      ? content.replace(/!\[[^\]]*\]\(data:[^)]*\)/g, "[скриншот]")
      : content;

  // AI Processing function
  const processWithAI = useCallback(
    async (
      transcription: string,
      prompt: string,
      previousMessages: Message[]
    ) => {
      // Supersede any in-flight request and start a fresh controller for THIS
      // call. The signal is passed to fetchAIResponse so the previous stream is
      // actually cancelled (previously it wasn't, causing overlapping answers).
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      const controller = new AbortController();
      abortControllerRef.current = controller;

      // Grab any queued screenshots so this question is sent WITH the images
      // (unified voice + screenshot context). Cleared in `finally` after the request.
      const pendingImages = screenshotImagesRef.current;

      try {
        setIsAIProcessing(true);
        setPendingUserMessage(transcription);
        setLastAIResponse("");
        setError("");

        let fullResponse = "";

        const usePluelyAPI = await shouldUsePluelyAPI();
        if (!selectedAIProvider.provider && !usePluelyAPI) {
          setError("No AI provider selected.");
          return;
        }

        const provider = allAiProviders.find(
          (p) => p.id === selectedAIProvider.provider
        );
        if (!provider && !usePluelyAPI) {
          setError("AI provider config not found.");
          return;
        }

        // Build the history to send, in CHRONOLOGICAL order (oldest → newest),
        // which is what both API paths now expect. previousMessages is
        // newest-first. In unlimited mode we send the whole session verbatim;
        // otherwise keep the most-recent N and fold older ones into a cheap
        // local digest appended to the system prompt.
        let recentChrono: Message[];
        let digest = "";
        if (unlimitedContextRef.current) {
          recentChrono = [...previousMessages].reverse();
        } else {
          const size = contextSizeRef.current;
          const recent = previousMessages.slice(0, size);
          const older = previousMessages.slice(size);
          digest = compressOlderRef.current ? buildOlderDigest(older) : "";
          recentChrono = [...recent].reverse();
        }
        const effectivePrompt = digest
          ? `${prompt}\n\n[Ранее в этой сессии — сжатая память о более старых сообщениях]:\n${digest}`
          : prompt;
        const maxHistoryMessages = unlimitedContextRef.current
          ? 100000
          : contextSizeRef.current;

        try {
          for await (const chunk of fetchAIResponse({
            provider: usePluelyAPI ? undefined : provider,
            selectedProvider: selectedAIProvider,
            systemPrompt: effectivePrompt,
            history: recentChrono.map((m) => ({
              ...m,
              content: stripDataUrlImages(m.content as string),
            })),
            userMessage: transcription,
            imagesBase64: pendingImages,
            signal: controller.signal,
            maxHistoryMessages,
          })) {
            if (controller.signal.aborted) break;
            fullResponse += chunk;
            setLastAIResponse((prev) => prev + chunk);
          }
        } catch (aiError: any) {
          // Ignore errors from a request we deliberately superseded.
          if (!controller.signal.aborted && aiError?.name !== "AbortError") {
            setError(aiError.message || "Failed to get AI response");
          }
        }

        if (fullResponse && !controller.signal.aborted) {
          const timestamp = Date.now();
          setConversation((prev) => ({
            ...prev,
            messages: [
              {
                id: generateMessageId("user", timestamp),
                role: "user" as const,
                // Embed each screenshot as a data-URL image so they show in the
                // feed and are saved with the dialog. Stripped from API history.
                content: pendingImages.length
                  ? `${transcription}\n\n${pendingImages
                      .map(
                        (img) =>
                          `![screenshot](data:image/png;base64,${img})`
                      )
                      .join("\n\n")}`
                  : transcription,
                timestamp,
              },
              {
                id: generateMessageId("assistant", timestamp + 1),
                role: "assistant" as const,
                content: fullResponse,
                timestamp: timestamp + 1,
              },
              ...prev.messages,
            ],
            updatedAt: timestamp,
            title: prev.title || generateConversationTitle(transcription),
          }));
        }
      } catch (err) {
        if (!controller.signal.aborted) setError("Failed to get AI response");
      } finally {
        // Only reset shared UI state if we're still the active request — a
        // superseded one must not switch off the indicator the new one turned on.
        if (abortControllerRef.current === controller) {
          setIsAIProcessing(false);
          setPendingUserMessage("");
        }
        // Screenshots have been consumed by this request; clear the queue.
        if (pendingImages.length) clearScreenshots();
        // No auto-restart - user manually controls when to start next recording
      }
    },
    [selectedAIProvider, allAiProviders, conversation.messages, clearScreenshots]
  );

  // Send a typed question into the SAME voice conversation (with any attached
  // screenshot). Lets the user work entirely inside the Listen popover.
  const submitText = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setError("");
      const effectiveSystemPrompt = useSystemPrompt
        ? presetPromptRef.current || systemPrompt || DEFAULT_SYSTEM_PROMPT
        : contextContent || DEFAULT_SYSTEM_PROMPT;
      const previousMessages = conversation.messages.map((msg) => ({
        role: msg.role,
        content: msg.content,
      }));
      await processWithAI(trimmed, effectiveSystemPrompt, previousMessages);
    },
    [
      useSystemPrompt,
      systemPrompt,
      contextContent,
      conversation.messages,
      processWithAI,
    ]
  );

  // Accumulate-mode controls (auto-detect). Toggle buffering, send the buffered
  // question on demand, or clear it.
  const setAccumulateMode = useCallback((value: boolean) => {
    accumulateModeRef.current = value;
    setAccumulateModeState(value);
    // Turning it off drops any buffered text (the buffer only exists to hold a
    // multi-part question while accumulating).
    if (!value) {
      accumulatedTextRef.current = "";
      setAccumulatedTextState("");
    }
  }, []);

  const clearAccumulated = useCallback(() => {
    accumulatedTextRef.current = "";
    setAccumulatedTextState("");
  }, []);

  const sendAccumulated = useCallback(async () => {
    const text = accumulatedTextRef.current.trim();
    if (!text) return;
    // Clear first so incoming phrases don't append to what we're sending.
    accumulatedTextRef.current = "";
    setAccumulatedTextState("");
    await submitText(text);
  }, [submitText]);

  // Screenshot hotkey action: capture AND immediately send it to the active
  // session with a default analysis prompt, so the user gets an answer (and
  // the screenshot appears + is saved in the dialog).
  const captureScreenshotAndSubmit = useCallback(async () => {
    await captureScreenshot();
    if (screenshotImagesRef.current.length) {
      await submitText(
        "Проанализируй скриншот и помоги: дай точный, пошаговый ответ по существу."
      );
    }
  }, [captureScreenshot, submitText]);

  // Keep the hotkey ref pointing at the latest action.
  useEffect(() => {
    captureAndSubmitRef.current = captureScreenshotAndSubmit;
  }, [captureScreenshotAndSubmit]);

  // Keep the selected-preset prompt in sync; expose a setter.
  useEffect(() => {
    const preset = SESSION_PRESETS.find((p) => p.id === sessionPresetId);
    presetPromptRef.current = preset ? preset.prompt : "";
  }, [sessionPresetId]);

  const setSessionPreset = useCallback((id: string) => {
    setSessionPresetIdState(id);
    safeLocalStorage.setItem("session_preset_id", id);
  }, []);

  // History browser: list past voice sessions and open one to continue it.
  const refreshPastConversations = useCallback(async () => {
    try {
      const all = await getAllConversations();
      setPastConversations(all.filter((c) => c.id.startsWith("sysaudio")));
    } catch (err) {
      console.error("Failed to load past conversations:", err);
    }
  }, []);

  const loadConversation = useCallback(async (id: string) => {
    try {
      const conv = await getConversationById(id);
      if (conv) {
        setConversation(conv);
        setLastAIResponse("");
        setLastTranscription("");
        setPendingUserMessage("");
        setError("");
        // Open in a "paused / ready to continue" state: window stays open,
        // the feed shows the loaded messages, and pressing play (or typing,
        // or Ctrl+Shift+S) continues this same session.
        setCapturing(false);
        setPaused(true);
        setIsPopoverOpen(true);
      }
    } catch (err) {
      console.error("Failed to load conversation:", err);
    }
  }, []);

  const startCapture = useCallback(async (resume: boolean = false) => {
    try {
      setError("");

      const hasAccess = await invoke<boolean>("check_system_audio_access");
      if (!hasAccess) {
        setSetupRequired(true);
        setIsPopoverOpen(true);
        return;
      }

      const isContinuous = !vadConfig.enabled;

      // Set up conversation — but when RESUMING keep the existing conversation
      // so the context (transcript + AI answers) is preserved across pauses.
      if (!resume) {
        const conversationId = generateConversationId("sysaudio");
        setConversation({
          id: conversationId,
          title: "",
          messages: [],
          createdAt: 0,
          updatedAt: 0,
        });
      }

      setPaused(false);
      setCapturing(true);
      setIsPopoverOpen(true);
      setIsContinuousMode(isContinuous);
      setRecordingProgress(0);

      // If continuous mode
      if (isContinuous) {
        setIsRecordingInContinuousMode(false);
        return;
      }

      // VAD mode: Start recording immediately
      // Stop any existing capture
      await invoke<string>("stop_system_audio_capture");

      const deviceId =
        selectedAudioDevices.output.id !== "default"
          ? selectedAudioDevices.output.id
          : null;

      // Start capture with VAD config
      await invoke<string>("start_system_audio_capture", {
        vadConfig: vadConfig,
        deviceId: deviceId,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
      setIsPopoverOpen(true);
    }
  }, [vadConfig, selectedAudioDevices.output.id]);

  const stopCapture = useCallback(async () => {
    try {
      // Abort any ongoing AI requests
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }

      // Stop the audio capture
      await invoke<string>("stop_system_audio_capture");

      // Reset ALL states
      setCapturing(false);
      setPaused(false);
      setIsProcessing(false);
      setIsAIProcessing(false);
      setIsContinuousMode(false);
      setIsRecordingInContinuousMode(false);
      setRecordingProgress(0);
      setLastTranscription("");
      setLastAIResponse("");
      setError("");
      setIsPopoverOpen(false);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(`Failed to stop capture: ${errorMessage}`);
      console.error("Stop capture error:", err);
    }
  }, []);

  // Pause: stop audio input but KEEP the window open and KEEP the conversation
  // context, so the user can resume later without losing anything. This is the
  // context-preserving counterpart to stopCapture.
  const pauseCapture = useCallback(async () => {
    try {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      await invoke<string>("stop_system_audio_capture");
      setCapturing(false);
      setPaused(true);
      setIsProcessing(false);
      setIsAIProcessing(false);
      setIsContinuousMode(false);
      setIsRecordingInContinuousMode(false);
      setRecordingProgress(0);
      // Intentionally keep lastTranscription, lastAIResponse and conversation.
      setIsPopoverOpen(true);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(`Failed to pause capture: ${errorMessage}`);
      console.error("Pause capture error:", err);
    }
  }, []);

  // Resume: continue capturing in the SAME conversation (no context reset).
  const resumeCapture = useCallback(async () => {
    await startCapture(true);
  }, [startCapture]);

  // Manual stop for continuous recording
  const manualStopAndSend = useCallback(async () => {
    try {
      // Proceed whenever a recording is actually in progress. (Previously this
      // only checked isContinuousMode, so any state drift silently dropped the
      // Stop & Send click — the "отправка не работает" symptom.)
      if (!isContinuousMode && !isRecordingInContinuousMode) {
        console.warn("No active manual recording to stop");
        return;
      }

      // Show processing state immediately
      setIsProcessing(true);

      // Trigger manual stop event → backend flushes the buffer and emits
      // "speech-detected", which runs STT + AI in the shared listener.
      await invoke("manual_stop_continuous");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(`Failed to manually stop: ${errorMessage}`);
      setIsProcessing(false); // Clear processing state on error
      console.error("Manual stop error:", err);
    }
  }, [isContinuousMode, isRecordingInContinuousMode]);

  const handleSetup = useCallback(async () => {
    try {
      const platform = navigator.platform.toLowerCase();

      if (platform.includes("mac") || platform.includes("win")) {
        await invoke("request_system_audio_access");
      }

      // Delay to give the user time to grant permissions in the system dialog.
      await new Promise((resolve) => setTimeout(resolve, 3000));

      const hasAccess = await invoke<boolean>("check_system_audio_access");
      if (hasAccess) {
        setSetupRequired(false);
        await startCapture();
      } else {
        setSetupRequired(true);
        setError("Permission not granted. Please try the manual steps.");
      }
    } catch (err) {
      setError("Failed to request access. Please try the manual steps below.");
      setSetupRequired(true);
    }
  }, [startCapture]);

  useEffect(() => {
    const shouldOpenPopover =
      hideLevel === 0 &&
      (capturing ||
        paused ||
        setupRequired ||
        isAIProcessing ||
        !!lastAIResponse ||
        !!error);
    setIsPopoverOpen(shouldOpenPopover);
    resizeWindow(shouldOpenPopover);
  }, [
    hideLevel,
    capturing,
    paused,
    setupRequired,
    isAIProcessing,
    lastAIResponse,
    error,
    resizeWindow,
  ]);

  // Ctrl+\ cycles the visibility level (dialog → +panel → back). We own the
  // whole 3-state machine here and ignore the event payload.
  useEffect(() => {
    const unlistenPromise = listen("toggle-window-visibility", () => {
      setHideLevel((l) => (l + 1) % 3);
    });
    return () => {
      unlistenPromise.then((f) => f()).catch(() => undefined);
    };
  }, []);

  // Apply the visibility level to the OS window: real click-through at level 2
  // (whole window), and force the dialog closed at levels 1–2 so the freed
  // area sits outside the shrunk window and clicks pass through there.
  useEffect(() => {
    // Real OS-level click-through via a dedicated Rust command. The JS
    // `setIgnoreCursorEvents` did not take effect on this transparent overlay,
    // so at level 2 the hidden strip still swallowed clicks. The backend
    // `set_ignore_cursor_events` is reliable.
    invoke("set_click_through", { ignore: hideLevel === 2 }).catch(() =>
      undefined
    );
    if (hideLevel >= 1) {
      setIsPopoverOpen(false);
      resizeWindow(false);
    }
  }, [hideLevel, resizeWindow]);

  useEffect(() => {
    globalShortcuts.registerSystemAudioCallback(async () => {
      if (capturing) {
        await pauseCapture();
      } else if (paused) {
        await resumeCapture();
      } else {
        await startCapture(false);
      }
    });
  }, [
    startCapture,
    stopCapture,
    pauseCapture,
    resumeCapture,
    capturing,
    paused,
  ]);

  // While the Listen popover is active (capturing OR paused), the screenshot
  // hotkey attaches the shot to THIS voice conversation instead of the hidden
  // Ask box. Cleared when the popover is inactive so the Ask box works again.
  useEffect(() => {
    // Route the screenshot hotkey to the VOICE session whenever the Listen
    // window is open (capturing, paused, OR just showing the chat). Uses a ref
    // so it registers once per open/close and never de-registers on re-render.
    if (capturing || paused || isPopoverOpen) {
      globalShortcuts.registerScreenshotCallbackPriority(() =>
        captureAndSubmitRef.current()
      );
      return () => {
        globalShortcuts.registerScreenshotCallbackPriority(null);
      };
    }
  }, [capturing, paused, isPopoverOpen]);

  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      invoke("stop_system_audio_capture").catch(() => {});
    };
  }, []);

  // Debounced save to prevent race conditions and improve performance
  useEffect(() => {
    // Clear any pending save
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // Only debounce if there are messages to save
    if (
      !conversation.id ||
      conversation.updatedAt === 0 ||
      conversation.messages.length === 0
    ) {
      return;
    }

    // Debounce saves (only save 500ms after last change)
    saveTimeoutRef.current = setTimeout(async () => {
      // Don't save if already saving (prevent concurrent saves)
      if (isSavingRef.current) {
        return;
      }

      try {
        isSavingRef.current = true;
        await saveConversation(conversation);
      } catch (error) {
        console.error("Failed to save system audio conversation:", error);
      } finally {
        isSavingRef.current = false;
      }
    }, CONVERSATION_SAVE_DEBOUNCE_MS);

    // Cleanup on unmount or dependency change
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [
    conversation.messages.length,
    conversation.title,
    conversation.id,
    conversation.updatedAt,
  ]);

  const startNewConversation = useCallback(() => {
    setConversation({
      id: generateConversationId("sysaudio"),
      title: "",
      messages: [],
      createdAt: 0,
      updatedAt: 0,
    });
    setLastTranscription("");
    setLastAIResponse("");
    setPendingUserMessage("");
    setError("");
    setSetupRequired(false);
    setIsProcessing(false);
    setIsAIProcessing(false);
    // Keep the popover OPEN so a new session starts right in the same window.
    setIsPopoverOpen(true);
    setUseSystemPrompt(true);
  }, []);

  // Update VAD configuration
  const updateVadConfiguration = useCallback(async (config: VadConfig) => {
    try {
      setVadConfig(config);
      safeLocalStorage.setItem("vad_config", JSON.stringify(config));
      await invoke("update_vad_config", { config });
    } catch (error) {
      console.error("Failed to update VAD config:", error);
    }
  }, []);

  useEffect(() => {
    if (capturing) {
      setIsContinuousMode(!vadConfig.enabled);

      if (!vadConfig.enabled) {
        setIsRecordingInContinuousMode(false);
      }
    }
  }, [vadConfig.enabled, capturing]);

  // Keyboard arrow key support for scrolling (local shortcut)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isPopoverOpen) return;

      const scrollElement = scrollAreaRef.current?.querySelector(
        "[data-radix-scroll-area-viewport]"
      ) as HTMLElement;

      if (!scrollElement) return;

      const scrollAmount = 100; // pixels to scroll

      if (e.key === "ArrowDown") {
        e.preventDefault();
        scrollElement.scrollBy({ top: scrollAmount, behavior: "smooth" });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        scrollElement.scrollBy({ top: -scrollAmount, behavior: "smooth" });
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isPopoverOpen]);

  // Keyboard shortcuts for continuous mode recording (local shortcuts)
  useEffect(() => {
    const handleRecordingShortcuts = (e: KeyboardEvent) => {
      if (!isPopoverOpen || !isContinuousMode) return;
      if (isProcessing || isAIProcessing) return;

      // Enter: Start recording (when not recording) or Stop & Send (when
      // recording) — but NOT while the user is typing in a text field.
      if (
        e.key === "Enter" &&
        !e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        if (!isRecordingInContinuousMode) {
          startContinuousRecording();
        } else {
          manualStopAndSend();
        }
      }

      // Escape: Ignore recording (when recording)
      if (e.key === "Escape" && isRecordingInContinuousMode) {
        e.preventDefault();
        ignoreContinuousRecording();
      }

      // Space: Start recording (when not recording) - only if not typing in input
      if (
        e.key === " " &&
        !isRecordingInContinuousMode &&
        !e.metaKey &&
        !e.ctrlKey &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        startContinuousRecording();
      }
    };

    window.addEventListener("keydown", handleRecordingShortcuts);
    return () =>
      window.removeEventListener("keydown", handleRecordingShortcuts);
  }, [
    isPopoverOpen,
    isContinuousMode,
    isRecordingInContinuousMode,
    isProcessing,
    isAIProcessing,
    startContinuousRecording,
    manualStopAndSend,
    ignoreContinuousRecording,
  ]);

  return {
    capturing,
    paused,
    hideLevel,
    setHideLevel,
    isProcessing,
    isAIProcessing,
    lastTranscription,
    lastAIResponse,
    error,
    setupRequired,
    startCapture,
    stopCapture,
    pauseCapture,
    resumeCapture,
    // Screenshots (queue attached to the next question for unified context)
    screenshotImages,
    removeScreenshot,
    clearScreenshots,
    isCapturingScreenshot,
    captureScreenshot,
    handleSetup,
    isPopoverOpen,
    setIsPopoverOpen,
    // Conversation management
    conversation,
    setConversation,
    // AI processing
    processWithAI,
    // Context management
    useSystemPrompt,
    setUseSystemPrompt: updateUseSystemPrompt,
    contextContent,
    setContextContent: updateContextContent,
    contextSize,
    setContextSize,
    compressOlder,
    setCompressOlder,
    unlimitedContext,
    setUnlimitedContext,
    startNewConversation,
    // Window resize
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
    captureScreenshotAndSubmit,
    // History browser
    pastConversations,
    refreshPastConversations,
    loadConversation,
    // Session presets (system prompt)
    sessionPresetId,
    setSessionPreset,
    // VAD configuration
    vadConfig,
    updateVadConfiguration,
    // Accumulate mode (auto-detect: buffer phrases, send on demand)
    accumulateMode,
    setAccumulateMode,
    accumulatedText,
    sendAccumulated,
    clearAccumulated,
    // Continuous recording
    isContinuousMode,
    isRecordingInContinuousMode,
    recordingProgress,
    manualStopAndSend,
    startContinuousRecording,
    ignoreContinuousRecording,
    // Scroll area ref for keyboard navigation
    scrollAreaRef,
  };
}
