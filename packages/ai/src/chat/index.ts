import { StateGraph, END, START } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import {
  ConversationState,
  loadContextNode,
  generateResponseNode,
  persistResponseNode,
  type ConversationStateType
} from "../graph";
import { agentTools } from "../graph/tools";
import type { ConversationKey, Conversation } from "@userbrot/core";
import { conversationRepo, messageRepo } from "@userbrot/core";

// Define the ToolNode using our extracted Agentic tools
const toolNode = new ToolNode<ConversationStateType>(agentTools);

// Conditional routing: If the LLM output contains tool calls, go to ToolNode.
// Otherwise, proceed to persist the final response.
function shouldContinue(state: ConversationStateType): "tools" | "persistResponse" {
  const lastMessage = state.messages[state.messages.length - 1];
  // LangChain AIMessage exposes tool calls via .tool_calls (array)
  const toolCalls = (lastMessage as any)?.tool_calls;
  const decision = Array.isArray(toolCalls) && toolCalls.length > 0 ? "tools" : "persistResponse";
  console.log("[shouldContinue] tool_calls:", JSON.stringify(toolCalls ?? null), "-> routing to:", decision);
  return decision;
}

const graphBuilder = new StateGraph(ConversationState)
  .addNode("loadContext", loadContextNode)
  .addNode("generateResponse", generateResponseNode)
  .addNode("tools", toolNode)
  .addNode("persistResponse", persistResponseNode)
  .addEdge(START, "loadContext")
  .addEdge("loadContext", "generateResponse")
  .addConditionalEdges("generateResponse", shouldContinue)
  .addEdge("tools", "generateResponse")
  .addEdge("persistResponse", END);

const graph = graphBuilder.compile();

export type RunConversationOptions = {
  surface: "telegram_bot" | "web" | "api";
  externalChatId: string;
  externalThreadId: string | null;
  userInput: string;
  onChunk?: (chunk: string) => void | Promise<void>;
  onStatus?: (status: string) => void | Promise<void>;
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

  let isExecutingTool = false;

  const invokeConfig = {
    callbacks: [
      {
        handleLLMNewToken(token: string) {
          if (!isExecutingTool && options.onChunk) {
            options.onChunk(token);
          }
        },
        handleChatModelStart(llm: any, messages: any[]) {
          // Reset tool execution flag on new LLM spinups
          isExecutingTool = false;
        },
        handleToolStart(tool: any, input: any) {
          isExecutingTool = true;
          if (options.onStatus) {
            const name = tool.name;
            const statusMap: Record<string, string> = {
              find_candidate_chats: "🔍 Finding relevant chats...",
              search_messages: "📚 Searching message history...",
              expand_context: "👀 Reading surrounding context...",
              get_chat_metadata: "📋 Getting chat details...",
              get_all_chats_overview: "📋 Loading chat overview...",
              get_messages_in_range: "📅 Fetching messages in date range...",
              get_recent_messages: "📨 Loading recent messages...",
              get_chat_activity_summary: "📊 Analyzing chat activity...",
              get_message_count_by_period: "📊 Counting messages...",
              search_messages_by_date: "🔍 Searching by date...",
              find_conversations_around_date: "📅 Finding conversations around date..."
            };
            const verb = statusMap[name] ?? "Using tool...";
            options.onStatus(verb);
          }
        },
        handleToolEnd() {
          // We keep isExecutingTool true here because the LLM will immediately generate
          // again, and we rely on handleChatModelStart to reset it, preventing a flicker.
        }
      }
    ]
  };

  const result = await graph.invoke(initialState, invokeConfig);

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
