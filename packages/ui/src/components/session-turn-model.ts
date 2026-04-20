import type { AssistantMessage, Message as MessageType } from "@opencode-ai/sdk/v2/client"

export function resolvedUserModel(message: MessageType | undefined, assistantMessages: readonly AssistantMessage[]) {
  if (!message || message.role !== "user") return

  for (let i = assistantMessages.length - 1; i >= 0; i--) {
    const item = assistantMessages[i]
    if (!item) continue
    if (item.parentID !== message.id) continue
    if (item.providerID !== message.model.providerID) continue
    if (item.modelID === "auto") continue
    return item
  }
}
