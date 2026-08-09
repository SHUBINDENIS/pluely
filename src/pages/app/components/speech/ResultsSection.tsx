import { ChatConversation } from "@/types";
import { Markdown, CopyButton } from "@/components";
import { BotIcon, HeadphonesIcon, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type Props = {
  lastAIResponse: string;
  isAIProcessing: boolean;
  conversation: ChatConversation;
  pendingUserMessage: string;
};

// A single chat bubble. `user` = your question / the interlocutor's speech /
// a screenshot prompt; `assistant` = the AI answer. Screenshots embedded in the
// content as data-URL images render inline (and are capped in height).
const Bubble = ({
  role,
  content,
  streaming,
}: {
  role: "user" | "assistant" | "system";
  content: string;
  streaming?: boolean;
}) => {
  const isUser = role === "user" || role === "system";
  return (
    <div
      className={cn(
        "rounded-md p-2.5 text-sm",
        isUser ? "border-l-2 border-primary/50 bg-primary/5" : "bg-background/60"
      )}
    >
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-1.5">
          {isUser ? (
            <HeadphonesIcon className="h-3 w-3 text-primary" />
          ) : (
            <BotIcon className="h-3 w-3 text-muted-foreground" />
          )}
          <span
            className={cn(
              "text-[9px] font-medium uppercase tracking-wide",
              isUser ? "text-primary" : "text-muted-foreground"
            )}
          >
            {isUser ? "Вопрос" : "Ответ"}
          </span>
        </div>
        {!isUser && !streaming && content && <CopyButton content={content} />}
      </div>
      <div className="prose prose-sm max-w-none dark:prose-invert [&_img]:max-h-48 [&_img]:rounded-md [&_img]:border [&_img]:border-border/50">
        <Markdown>{content}</Markdown>
        {streaming && (
          <span className="inline-block w-2 h-4 bg-primary animate-pulse ml-1 align-middle" />
        )}
      </div>
    </div>
  );
};

export const ResultsSection = ({
  lastAIResponse,
  isAIProcessing,
  conversation,
  pendingUserMessage,
}: Props) => {
  // Completed turns, newest first (so the latest answer is at the top).
  const ordered = [...conversation.messages].sort(
    (a, b) => b.timestamp - a.timestamp
  );

  if (!isAIProcessing && !lastAIResponse && ordered.length === 0) {
    return null;
  }

  return (
    <div className="rounded-lg border border-border/50 bg-muted/20 p-2 space-y-2 max-h-[52vh] overflow-y-auto">
      {/* In-progress turn (newest, on top) */}
      {isAIProcessing && (
        <>
          {lastAIResponse ? (
            <Bubble role="assistant" content={lastAIResponse} streaming />
          ) : (
            <div className="flex items-center gap-2 p-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
              <span className="text-[10px] text-muted-foreground">Думаю…</span>
            </div>
          )}
          {pendingUserMessage && (
            <Bubble role="user" content={pendingUserMessage} />
          )}
        </>
      )}

      {/* Completed turns */}
      {ordered.map((message, index) => (
        <Bubble
          key={message.id || index}
          role={message.role}
          content={message.content}
        />
      ))}
    </div>
  );
};
