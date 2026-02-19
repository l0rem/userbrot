import type { ConversationStateType } from "../state";
import { conversationRepo, messageRepo } from "@userbrot/core";
import { dbMessagesToLangChain } from "../../memory";

export async function loadContextNode(
  state: ConversationStateType
): Promise<Partial<ConversationStateType>> {
  if (!state.conversationId) {
    throw new Error("conversationId is not set in state");
  }

  const conversation = await conversationRepo.getById(state.conversationId);
  if (!conversation) {
    throw new Error(`Conversation not found for ID: ${state.conversationId}`);
  }

  const history = await messageRepo.getForContext(conversation.id, 4000);
  const messages = dbMessagesToLangChain(history);

  return {
    conversationId: conversation.id,
    conversation,
    history,
    messages
  };
}
