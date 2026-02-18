import { getEnv, requireBotToken } from "@userbrot/core/env";
import { Bot } from "gramio";

const token = requireBotToken();
const webAppUrl = getEnv().WEB_APP_URL;
const setupUrl = new URL("/setup", webAppUrl.endsWith("/") ? webAppUrl : `${webAppUrl}/`);
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
        "Welcome to userbrot. Use the setup flow in Mini App to activate your private userbot instance.",
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
              ]
            ]
          }
        }
      );
      return;
    }

    await context.send(
      "Welcome to userbrot. Setup Mini App button is disabled because WEB_APP_URL is not HTTPS.\n\n" +
        `For local testing, open this URL manually: ${setupUrl.toString()}\n` +
        "To enable the in-chat setup button, expose web app via HTTPS tunnel and set WEB_APP_URL to that public URL."
    );
  })
  .onStart(({ info }) => {
    console.log(`bot started as @${info.username}`);
  });

await bot.start();
