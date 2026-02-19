import { StateGraph, END, START } from "@langchain/langgraph";
import {
  ConversationState,
  loadContextNode,
  generateResponseNode,
  persistResponseNode,
  type ConversationStateType
} from "../graph";
import type { ConversationKey, Conversation } from "@userbrot/core";
import { conversationRepo, messageRepo } from "@userbrot/core";

const graphBuilder = new StateGraph(ConversationState)
  .addNode("loadContext", loadContextNode)
  .addNode("generateResponse", generateResponseNode)
  .addNode("persistResponse", persistResponseNode)
  .addEdge(START, "loadContext")
  .addEdge("loadContext", "generateResponse")
  .addEdge("generateResponse", "persistResponse")
  .addEdge("persistResponse", END);

const graph = graphBuilder.compile();

export type RunConversationOptions = {
  surface: "telegram_bot" | "web" | "api";
  externalChatId: string;
  externalThreadId: string | null;
  userInput: string;
};

export type RunConversationResult = {
  conversationId: number;
  conversation: Conversation;
  assistantOutput: string;
  modelName: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
};

export async function runConversationTurn(
  options: RunConversationOptions
): Promise<RunConversationResult> {
  const key: ConversationKey = {
    surface: options.surface,
    externalChatId: options.externalChatId,
    externalThreadId: options.externalThreadId
  };

  const conversation = await conversationRepo.findOrCreate(key);

  const initialState: Partial<ConversationStateType> = {
    conversationId: conversation.id,
    conversation,
    userInput: options.userInput,
    history: [],
    messages: [],
    assistantOutput: "",
    modelName: null,
    inputTokens: null,
    outputTokens: null,
    error: null,
    startedAt: Date.now(),
    finishedAt: null
  };

  const result = await graph.invoke(initialState);

  const durationMs = (result.finishedAt ?? Date.now()) - result.startedAt;

  return {
    conversationId: result.conversationId,
    conversation: result.conversation!,
    assistantOutput: result.assistantOutput,
    modelName: result.modelName,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    durationMs
  };
}

export async function getConversationHistory(
  conversationId: number,
  limit: number = 50
) {
  return messageRepo.getForConversation(conversationId, limit);
}

export { graph };
