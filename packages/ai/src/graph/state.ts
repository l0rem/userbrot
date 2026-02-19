import { Annotation, messagesStateReducer } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";
import type { Message as DbMessage, Conversation } from "@userbrot/core";

export const ConversationState = Annotation.Root({
  conversationId: Annotation<number>,
  conversation: Annotation<Conversation | null>,
  userInput: Annotation<string>,
  history: Annotation<DbMessage[]>,
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => []
  }),
  assistantOutput: Annotation<string>,
  modelName: Annotation<string | null>,
  inputTokens: Annotation<number | null>,
  outputTokens: Annotation<number | null>,
  error: Annotation<string | null>,
  startedAt: Annotation<number>,
  finishedAt: Annotation<number | null>
});

export type ConversationStateType = typeof ConversationState.State;
