import type { ConversationStateType } from "../state";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { requireLlmProviderConfig, messageRepo } from "@userbrot/core";
import { SYSTEM_PROMPT } from "../../prompts";

export async function generateResponseNode(
  state: ConversationStateType
): Promise<Partial<ConversationStateType>> {
  const llmConfig = requireLlmProviderConfig();

  const model = new ChatOpenAI({
    model: llmConfig.model,
    openAIApiKey: llmConfig.apiKey,
    configuration: {
      baseURL: llmConfig.baseUrl
    },
    temperature: 0.7,
    streaming: true
  });

  // Bypass tiktoken error for non-OpenAI format models
  model.getNumTokens = async () => 0;

  await messageRepo.add(state.conversationId, "user", state.userInput);

  const systemMessage = new SystemMessage(SYSTEM_PROMPT);
  const userMessage = new HumanMessage(state.userInput);

  const allMessages = [systemMessage, ...state.messages, userMessage];

  const response = await model.invoke(allMessages);
  const assistantOutput = response.content.toString();

  const tokenUsage = response.response_metadata?.tokenUsage;

  return {
    assistantOutput,
    modelName: llmConfig.model,
    inputTokens: tokenUsage?.promptTokens ?? null,
    outputTokens: tokenUsage?.completionTokens ?? null,
    messages: [...state.messages, userMessage, response]
  };
}
