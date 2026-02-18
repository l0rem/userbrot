import { answerQuestionFromSyncedChats } from "@userbrot/core/services/ragService";
import { getEnv, getOwnerTelegramId, requireBotToken } from "@userbrot/core/env";
import { Bot } from "gramio";

const token = requireBotToken();
const webAppUrl = getEnv().WEB_APP_URL;
const fixedOwnerTelegramId = getOwnerTelegramId();
const setupUrl = new URL("/setup", webAppUrl.endsWith("/") ? webAppUrl : `${webAppUrl}/`);
const syncUrl = new URL("/sync", webAppUrl.endsWith("/") ? webAppUrl : `${webAppUrl}/`);
const supportsTelegramWebApp = setupUrl.protocol === "https:";

if (!supportsTelegramWebApp) {
  console.warn(
    `WEB_APP_URL is not HTTPS (${setupUrl.toString()}). Telegram Mini App buttons require HTTPS; falling back to text instructions.`
  );
}

const bot = new Bot(token)
  .command("start", async (context) => {
    if (supportsTelegramWebApp) {
      await context.send(
        "Welcome to userbrot. Use setup first, then sync chats, then ask questions in this bot.",
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
  .command("ask", async (context) => {
    const text = context.text ?? "";
    const question = text.replace(/^\/ask(?:@\w+)?\s*/i, "").trim();

    if (!question) {
      await context.send("Usage: /ask <question>");
      return;
    }

    const fromId = context.from?.id;
    if (fixedOwnerTelegramId && (!fromId || BigInt(fromId) !== fixedOwnerTelegramId)) {
      return;
    }

    const threadParams: {
      message_thread_id?: number;
      direct_messages_topic_id?: number;
    } = {};

    if (typeof context.payload.message_thread_id === "number") {
      threadParams.message_thread_id = context.payload.message_thread_id;
    }

    if (typeof context.payload.direct_messages_topic?.topic_id === "number") {
      threadParams.direct_messages_topic_id = context.payload.direct_messages_topic.topic_id;
    }

    try {
      const owner = fixedOwnerTelegramId ?? (fromId ? BigInt(fromId) : 1n);
      const result = await answerQuestionFromSyncedChats(owner, question);

      const citationLine =
        result.citations.length > 0
          ? `\n\nSources: ${result.citations
              .slice(0, 3)
              .map((item) => `${item.chatTitle}#${item.messageId}`)
              .join(", ")}`
          : "";

      await context.send(`${result.answer}${citationLine}`, threadParams);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await context.send(`Failed to answer question: ${message}`, threadParams);
    }
  })
  .on("message", async (context) => {
    const text = context.text?.trim();
    if (!text || text.startsWith("/")) {
      return;
    }

    const fromId = context.from?.id;
    if (fixedOwnerTelegramId && (!fromId || BigInt(fromId) !== fixedOwnerTelegramId)) {
      return;
    }

    const owner = fixedOwnerTelegramId ?? (fromId ? BigInt(fromId) : 1n);
    const threadParams: {
      message_thread_id?: number;
      direct_messages_topic_id?: number;
    } = {};

    if (typeof context.payload.message_thread_id === "number") {
      threadParams.message_thread_id = context.payload.message_thread_id;
    }

    if (typeof context.payload.direct_messages_topic?.topic_id === "number") {
      threadParams.direct_messages_topic_id = context.payload.direct_messages_topic.topic_id;
    }

    try {
      const result = await answerQuestionFromSyncedChats(owner, text);

      const citationLine =
        result.citations.length > 0
          ? `\n\nSources: ${result.citations
              .slice(0, 3)
              .map((item) => `${item.chatTitle}#${item.messageId}`)
              .join(", ")}`
          : "";

      await context.send(`${result.answer}${citationLine}`, threadParams);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await context.send(`Failed to answer question: ${message}`, threadParams);
    }
  })
  .onStart(({ info }) => {
    console.log(`bot started as @${info.username}`);
  });

await bot.start();
