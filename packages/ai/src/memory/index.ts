import type { Message as DbMessage } from "@userbrot/core";
import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";

export function dbMessagesToLangChain(messages: DbMessage[]): import("@langchain/core/messages").BaseMessage[] {
  return messages.map((msg) => {
    switch (msg.role) {
      case "user":
        return new HumanMessage(msg.content);
      case "assistant":
        return new AIMessage(msg.content);
      case "system":
        return new SystemMessage(msg.content);
      default:
        return new HumanMessage(msg.content);
    }
  });
}

export function formatHistoryForContext(messages: DbMessage[]): string {
  return messages
    .map((msg) => {
      const role = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
      return `${role}: ${msg.content}`;
    })
    .join("\n\n");
}
