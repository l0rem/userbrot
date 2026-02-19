import { getEnv, requireBotToken } from "@userbrot/core/env";
import { runConversationTurn, type RunConversationResult } from "@userbrot/ai";
import { Bot } from "gramio";
import { telegramMarkdownToHtml } from "./utils/markdown";

const token = requireBotToken();
const webAppUrl = getEnv().WEB_APP_URL;
const setupUrl = new URL("/setup", webAppUrl.endsWith("/") ? webAppUrl : `${webAppUrl}/`);
const syncUrl = new URL("/sync", webAppUrl.endsWith("/") ? webAppUrl : `${webAppUrl}/`);
const supportsTelegramWebApp = setupUrl.protocol === "https:";

const AI_GRAPH_ENABLED = getEnv().AI_GRAPH_ENABLED === "1";

type ReplyThreadParams = {
  message_thread_id?: number;
  direct_messages_topic_id?: number;
  parse_mode?: "HTML" | "MarkdownV2" | "Markdown";
};

type IncomingPayload = Record<string, unknown>;

type ChatInfo = {
  chatId: number | null;
  chatType: string | null;
  threadId: number | null;
  isTopicMessage: boolean;
};

type PrivateDraftTarget = {
  chatId: number;
  messageThreadId?: number;
};

type ReplyContext = {
  payload: unknown;
  send: (text: string, params?: ReplyThreadParams) => Promise<unknown>;
};

function parseInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function truncateTelegramText(text: string): string {
  if (text.length <= 4096) {
    return text;
  }

  return `${text.slice(0, 4095)}…`;
}

function createDraftId(): number {
  return Math.floor(Math.random() * 2_000_000_000) + 1;
}

function extractThreadParams(payload: IncomingPayload): ReplyThreadParams {
  const threadParams: ReplyThreadParams = {};

  const threadId = parseInteger(payload.message_thread_id);
  if (threadId !== null) {
    threadParams.message_thread_id = threadId;
  }

  const directTopicId = parseInteger(payload.direct_messages_topic_id);
  if (directTopicId !== null) {
    threadParams.direct_messages_topic_id = directTopicId;
  }

  const directTopic = payload.direct_messages_topic;
  if (typeof directTopic === "object" && directTopic !== null) {
    const topicId = parseInteger((directTopic as { topic_id?: unknown }).topic_id);
    if (topicId !== null) {
      threadParams.direct_messages_topic_id = topicId;
    }
  }

  return threadParams;
}

function extractChatInfo(payload: IncomingPayload): ChatInfo {
  const chat = payload.chat;
  const threadId = parseInteger(payload.message_thread_id);
  const isTopicMessage = payload.is_topic_message === true;

  if (typeof chat !== "object" || chat === null) {
    return {
      chatId: null,
      chatType: null,
      threadId,
      isTopicMessage
    };
  }

  const chatId = parseInteger((chat as { id?: unknown }).id);
  const rawType = (chat as { type?: unknown }).type;
  const chatType = typeof rawType === "string" ? rawType : null;

  return {
    chatId,
    chatType,
    threadId,
    isTopicMessage
  };
}

function extractPrivateDraftTarget(payload: IncomingPayload): PrivateDraftTarget | null {
  const chat = extractChatInfo(payload);
  if (chat.chatType !== "private" || chat.chatId === null) {
    return null;
  }

  return {
    chatId: chat.chatId,
    messageThreadId: chat.threadId ?? undefined
  };
}

function buildCitationLine(citations: Array<{ chatTitle: string; messageId: number }>): string {
  if (citations.length === 0) {
    return "";
  }

  return `\n\nSources: ${citations
    .slice(0, 3)
    .map((item) => `${item.chatTitle}#${item.messageId}`)
    .join(", ")}`;
}

// Removed legacy answerWithStreamingDraft (one-shot RAG)

async function answerWithLangGraph(
  context: ReplyContext,
  userInput: string
): Promise<void> {
  const payload = context.payload as IncomingPayload;
  const threadParams = extractThreadParams(payload);
  const chatInfo = extractChatInfo(payload);
  const draftTarget = extractPrivateDraftTarget(payload);
  const draftId = createDraftId();

  if (!chatInfo.chatId) {
    await context.send("Could not identify chat context.", threadParams);
    return;
  }

  const typingInterval = setInterval(async () => {
    try {
      await bot.api.sendChatAction({
        chat_id: chatInfo.chatId!,
        action: "typing",
        ...(chatInfo.threadId && { message_thread_id: chatInfo.threadId })
      });
    } catch { }
  }, 4000);

  let draftStreamingEnabled = Boolean(draftTarget);
  let lastDraftText = "";
  let lastDraftSentAt = 0;

  const pushDraft = async (value: string, force: boolean): Promise<void> => {
    if (!draftStreamingEnabled || !draftTarget) {
      return;
    }

    const nextDraft = truncateTelegramText(value.trim());
    if (!nextDraft || nextDraft === lastDraftText) {
      return;
    }

    const now = Date.now();
    if (!force && now - lastDraftSentAt < 700 && nextDraft.length - lastDraftText.length < 80) {
      return;
    }

    try {
      await bot.api.sendMessageDraft({
        chat_id: draftTarget.chatId,
        message_thread_id: draftTarget.messageThreadId,
        draft_id: draftId,
        text: telegramMarkdownToHtml(nextDraft),
        parse_mode: "HTML"
      });
      lastDraftText = nextDraft;
      lastDraftSentAt = now;
    } catch {
      draftStreamingEnabled = false;
    }
  };

  try {
    const result = await runConversationTurn({
      surface: "telegram_bot",
      externalChatId: String(chatInfo.chatId),
      externalThreadId: chatInfo.threadId ? String(chatInfo.threadId) : null,
      userInput,
      onChunk: async (chunk: string) => {
        await pushDraft(lastDraftText + chunk, false);
      },
      onStatus: async (status: string) => {
        // Render it instantly with an emphasize wrapper
        await pushDraft(`_${status}_`, true);
        // Clear lastDraftText so that when chunking resumes, it overrides the status
        lastDraftText = "";
      }
    });

    clearInterval(typingInterval);

    if (draftStreamingEnabled && draftTarget) {
      try {
        await bot.api.sendMessageDraft({
          chat_id: draftTarget.chatId,
          message_thread_id: draftTarget.messageThreadId,
          draft_id: draftId,
          text: ""
        });
      } catch { }
    }

    const responseText = truncateTelegramText(result.assistantOutput);
    const htmlOutput = telegramMarkdownToHtml(responseText);

    try {
      await context.send(htmlOutput, { ...threadParams, parse_mode: "HTML" });
    } catch (sendError) {
      console.error("[answerWithLangGraph] HTML send failed, falling back to plain text:", sendError);
      console.error("[answerWithLangGraph] Problematic HTML:", htmlOutput.slice(0, 500));
      const plainOutput = responseText
        .replace(/[<>]/g, "")
        .replace(/[&]/g, "and");
      await context.send(plainOutput, threadParams);
    }
  } catch (error) {
    clearInterval(typingInterval);
    console.error("[answerWithLangGraph] Error:", error);
    const message = error instanceof Error ? error.message : String(error);
    await context.send(`Failed to generate response: ${message}`, threadParams);
  }
}

if (!supportsTelegramWebApp) {
  console.warn(
    `WEB_APP_URL is not HTTPS (${setupUrl.toString()}). Telegram Mini App buttons require HTTPS; falling back to text instructions.`
  );
}

const bot = new Bot(token)
  .command("start", async (context) => {
    if (supportsTelegramWebApp) {
      await context.send(
        "Welcome to userbrot. Setup and sync your chats using the Web App buttons below, then send a message in this chat or topic to start an AI conversation.",
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Start Setup",
                  web_app: {
                    url: setupUrl.toString()
                  }
                }
              ],
              [
                {
                  text: "Open Sync",
                  web_app: {
                    url: syncUrl.toString()
                  }
                }
              ]
            ]
          }
        }
      );
      return;
    }

    await context.send(
      "Welcome to userbrot. Setup Mini App button is disabled because WEB_APP_URL is not HTTPS.\n\n" +
      `For local testing, open setup manually: ${setupUrl.toString()}\n` +
      `After setup, open sync manually: ${syncUrl.toString()}\n` +
      "To enable the in-chat setup button, expose web app via HTTPS tunnel and set WEB_APP_URL to that public URL."
    );
  })
  .command("topic", async (context) => {
    const payload = context.payload as unknown as IncomingPayload;
    const threadParams = extractThreadParams(payload);
    const chatInfo = extractChatInfo(payload);
    const args = context.args?.trim() ?? "";

    if (!args || /^where$/i.test(args)) {
      await context.send(
        `Topic context\nchat_type=${chatInfo.chatType ?? "unknown"}\nchat_id=${chatInfo.chatId ?? "unknown"}\nmessage_thread_id=${chatInfo.threadId ?? "none"}\nis_topic_message=${chatInfo.isTopicMessage ? "yes" : "no"}`,
        threadParams
      );
      return;
    }

    if (chatInfo.chatType !== "private" || chatInfo.chatId === null) {
      await context.send("/topic commands are supported only in your private chat with this bot.", threadParams);
      return;
    }

    const createMatch = args.match(/^create\s+(.+)$/i);
    if (createMatch) {
      const topicName = createMatch[1]?.trim();
      if (!topicName) {
        await context.send("Usage: /topic create <name>", threadParams);
        return;
      }

      try {
        const created = await bot.api.createForumTopic({
          chat_id: chatInfo.chatId,
          name: topicName
        });

        await context.send(
          `Created topic "${created.name}" with thread id ${created.message_thread_id}.`,
          { message_thread_id: created.message_thread_id }
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await context.send(`Failed to create topic: ${message}`, threadParams);
      }
      return;
    }

    const sendMatch = args.match(/^send\s+(\d+)\s+([\s\S]+)$/i);
    if (sendMatch) {
      const targetThreadId = Number.parseInt(sendMatch[1] ?? "", 10);
      const text = sendMatch[2]?.trim() ?? "";

      if (!Number.isInteger(targetThreadId) || targetThreadId <= 0 || text.length === 0) {
        await context.send("Usage: /topic send <thread_id> <text>", threadParams);
        return;
      }

      try {
        await bot.api.sendMessage({
          chat_id: chatInfo.chatId,
          message_thread_id: targetThreadId,
          text: truncateTelegramText(text)
        });
        await context.send(`Sent to topic ${targetThreadId}.`, threadParams);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await context.send(`Failed to send into topic ${targetThreadId}: ${message}`, threadParams);
      }
      return;
    }

    await context.send(
      "Usage:\n/topic where\n/topic create <name>\n/topic send <thread_id> <text>",
      threadParams
    );
  })
  .command("clear", async (context) => {
    const payload = context.payload as unknown as IncomingPayload;
    const threadParams = extractThreadParams(payload);
    const chatInfo = extractChatInfo(payload);

    if (!chatInfo.chatId) {
      await context.send("Could not identify chat context.", threadParams);
      return;
    }

    const { messageRepo, conversationRepo } = await import("@userbrot/core");
    const key = {
      surface: "telegram_bot" as const,
      externalChatId: String(chatInfo.chatId),
      externalThreadId: chatInfo.threadId ? String(chatInfo.threadId) : null
    };

    try {
      const conversation = await conversationRepo.findOrCreate(key);
      await messageRepo.deleteForConversation(conversation.id);
      await context.send("Conversation memory cleared. Starting fresh.", threadParams);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await context.send(`Failed to clear conversation: ${message}`, threadParams);
    }
  })
  .on("message", async (context) => {
    const text = context.text?.trim();
    if (!text || text.startsWith("/")) {
      return;
    }

    try {
      await answerWithLangGraph(context, text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const threadParams = extractThreadParams(context.payload as unknown as IncomingPayload);
      await context.send(`Failed to answer question: ${message}`, threadParams);
    }
  })
  .onStart(({ info }) => {
    console.log(`bot started as @${info.username}`);
  });

await bot.start();
