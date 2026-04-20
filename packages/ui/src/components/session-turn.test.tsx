import { describe, expect, test } from "bun:test"
import type { AssistantMessage, UserMessage } from "@opencode-ai/sdk/v2"
import { resolvedUserModel } from "./session-turn-model"

function userMessage(input?: Partial<UserMessage>): UserMessage {
  return {
    id: "msg_user",
    sessionID: "ses_1",
    role: "user",
    time: { created: 1 },
    agent: "swarm-orchestrator",
    model: {
      providerID: "github-copilot",
      modelID: "auto",
    },
    ...input,
  }
}

function assistantMessage(input?: Partial<AssistantMessage>): AssistantMessage {
  return {
    id: "msg_assistant",
    sessionID: "ses_1",
    role: "assistant",
    time: {
      created: 2,
      completed: 3,
    },
    parentID: "msg_user",
    modelID: "github-copilot/auto-resolved",
    providerID: "github-copilot",
    mode: "chat",
    agent: "swarm-orchestrator",
    path: {
      cwd: "/repo",
      root: "/repo",
    },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
    ...input,
  }
}

describe("resolvedUserModel", () => {
  test("prefers the resolved assistant model for the same provider", () => {
    const result = resolvedUserModel(userMessage(), [assistantMessage()])

    expect(result?.providerID).toBe("github-copilot")
    expect(result?.modelID).toBe("github-copilot/auto-resolved")
  })

  test("ignores unresolved auto assistant models", () => {
    const result = resolvedUserModel(userMessage(), [assistantMessage({ modelID: "auto" })])

    expect(result).toBeUndefined()
  })

  test("ignores assistant models from a different provider", () => {
    const result = resolvedUserModel(userMessage(), [assistantMessage({ providerID: "openai" })])

    expect(result).toBeUndefined()
  })

  test("uses the latest resolved assistant model when multiple exist", () => {
    const result = resolvedUserModel(userMessage(), [
      assistantMessage({ id: "msg_1", modelID: "github-copilot/old" }),
      assistantMessage({ id: "msg_2", modelID: "github-copilot/new" }),
    ])

    expect(result?.modelID).toBe("github-copilot/new")
  })
})
