import type { ConversationStateType } from "../state";
import { conversationRepo, messageRepo, type ConversationKey } from "@userbrot/core";
import { dbMessagesToLangChain } from "../../memory";

export async function loadContextNode(
  state: ConversationStateType
): Promise<Partial<ConversationStateType>> {
  const key: ConversationKey = {
    surface: "telegram_bot",
    externalChatId: String(state.conversationId),
    externalThreadId: null
  };

  const conversation = await conversationRepo.findOrCreate(key);
  const history = await messageRepo.getForContext(conversation.id, 4000);
  const messages = dbMessagesToLangChain(history);

  return {
    conversationId: conversation.id,
    conversation,
    history,
    messages
  };
}
