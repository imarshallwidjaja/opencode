import { expect, mock, test } from "bun:test"
import { createCopilotAutoModel } from "@/provider/sdk/copilot/auto-model"

test("throws when the Copilot auto session endpoint returns 404", async () => {
  const model = createCopilotAutoModel({
    baseURL: "https://api.githubcopilot.com",
    fetch: mock((input: RequestInfo | URL) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url

      if (url === "https://api.githubcopilot.com/models/session") {
        return Promise.resolve(new Response("Not Found", { status: 404 }))
      }

      return Promise.reject(new Error(`unexpected url: ${url}`))
    }) as never,
    headers: () => ({ Authorization: "Bearer copilot-token" }),
    createModel() {
      throw new Error("unexpected model selection")
    },
  })

  await expect(model.doGenerate({ prompt: [] } as never)).rejects.toThrow(
    "Failed to create auto model session: 404 Not Found",
  )
})

test("uses the live auto session and intent payload shapes", async () => {
  const generateResult = {
    providerMetadata: {
      existing: {
        keep: true,
      },
    },
  } as never
  const innerModel = {
    doGenerate: mock(() => Promise.resolve(generateResult)),
    doStream: mock(() => Promise.reject(new Error("unused"))),
  }
  const createModel = mock(() => innerModel) as never

  const model = createCopilotAutoModel({
    baseURL: "https://api.githubcopilot.com",
    fetch: mock((input: RequestInfo | URL) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url

      if (url === "https://api.githubcopilot.com/models/session") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              available_models: ["gpt-5.3-codex", "claude-sonnet-4.6", "gpt-4o"],
              selected_model: "gpt-5.3-codex",
              session_token: "session-token",
              expires_at: Math.floor(Date.now() / 1000) + 1800,
              discounted_costs: {
                "gpt-5.3-codex": 0,
              },
            }),
            { status: 200 },
          ),
        )
      }

      if (url === "https://api.githubcopilot.com/models/session/intent") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              predicted_label: "no_reasoning",
              confidence: 1,
              latency_ms: 14,
              chosen_model: "claude-sonnet-4.6",
              candidate_models: ["claude-sonnet-4.6", "gpt-4o"],
              scores: {
                no_reasoning: 1,
              },
              sticky_override: false,
              routing_method: "binary",
              fallback: false,
            }),
            { status: 200 },
          ),
        )
      }

      return Promise.reject(new Error(`unexpected url: ${url}`))
    }) as never,
    headers: () => ({ Authorization: "Bearer copilot-token" }),
    createModel,
  })

  await expect(model.doGenerate({ prompt: [] } as never)).resolves.toMatchObject({
    providerMetadata: {
      existing: {
        keep: true,
      },
      opencode: {
        modelId: "claude-sonnet-4.6",
      },
    },
  })
  expect(createModel).toHaveBeenCalledWith("claude-sonnet-4.6", {
    "Copilot-Session-Token": "session-token",
  })
})

test("sends only the allowlisted locally executable session models to intent routing", async () => {
  const previousAllowlist = process.env.COPILOT_AUTO_MODEL_ALLOWLIST
  process.env.COPILOT_AUTO_MODEL_ALLOWLIST = " claude-opus-4.7, gpt-5.4, gpt-5.5, gpt-5.4 "
  let intentBody: Record<string, unknown> | undefined

  try {
    const model = createCopilotAutoModel({
      baseURL: "https://api.githubcopilot.com",
      executableModelIds: ["gpt-4.1", "gpt-5.4"],
      fetch: mock((input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url

        if (url === "https://api.githubcopilot.com/models/session") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                available_models: ["claude-haiku-4.5", "claude-sonnet-4.6", "gpt-4.1", "gpt-4o", "gpt-5.4"],
                session_token: "session-token",
                expires_at: Math.floor(Date.now() / 1000) + 1800,
              }),
              { status: 200 },
            ),
          )
        }

        if (url === "https://api.githubcopilot.com/models/session/intent") {
          intentBody = JSON.parse(String(init?.body))
          return Promise.resolve(
            new Response(
              JSON.stringify({
                candidate_models: ["gpt-5.4"],
              }),
              { status: 200 },
            ),
          )
        }

        return Promise.reject(new Error(`unexpected url: ${url}`))
      }) as never,
      headers: () => ({ Authorization: "Bearer copilot-token" }),
      createModel: mock(() => ({ doGenerate: mock(() => Promise.resolve({} as never)), doStream: mock() })) as never,
    })

    await model.doGenerate({ prompt: [] } as never)

    expect(intentBody?.available_models).toEqual(["gpt-5.4"])
  } finally {
    if (previousAllowlist === undefined) delete process.env.COPILOT_AUTO_MODEL_ALLOWLIST
    else process.env.COPILOT_AUTO_MODEL_ALLOWLIST = previousAllowlist
  }
})

test("fails before intent routing when the allowlisted executable session model set is empty", async () => {
  const previousAllowlist = process.env.COPILOT_AUTO_MODEL_ALLOWLIST
  process.env.COPILOT_AUTO_MODEL_ALLOWLIST = "claude-opus-4.7,gpt-5.5"
  const fetch = mock((input: RequestInfo | URL) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url

    if (url === "https://api.githubcopilot.com/models/session") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            available_models: ["claude-haiku-4.5", "gpt-5.4"],
            session_token: "session-token",
            expires_at: Math.floor(Date.now() / 1000) + 1800,
          }),
          { status: 200 },
        ),
      )
    }

    return Promise.reject(new Error(`unexpected url: ${url}`))
  })

  try {
    const model = createCopilotAutoModel({
      baseURL: "https://api.githubcopilot.com",
      executableModelIds: ["gpt-5.4"],
      fetch: fetch as never,
      headers: () => ({ Authorization: "Bearer copilot-token" }),
      createModel() {
        throw new Error("unexpected model selection")
      },
    })

    await expect(model.doGenerate({ prompt: [] } as never)).rejects.toThrow(
      "No Copilot auto models are available after applying COPILOT_AUTO_MODEL_ALLOWLIST",
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  } finally {
    if (previousAllowlist === undefined) delete process.env.COPILOT_AUTO_MODEL_ALLOWLIST
    else process.env.COPILOT_AUTO_MODEL_ALLOWLIST = previousAllowlist
  }
})

test("builds a routing prompt with metadata, latest user text, and earlier turn summary", async () => {
  let intentBody: Record<string, unknown> | undefined
  const model = createCopilotAutoModel({
    baseURL: "https://api.githubcopilot.com",
    fetch: mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url

      if (url === "https://api.githubcopilot.com/models/session") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              available_models: ["gpt-5.3-codex", "claude-sonnet-4.6", "gpt-4o"],
              selected_model: "gpt-5.3-codex",
              session_token: "session-token",
              expires_at: Math.floor(Date.now() / 1000) + 1800,
            }),
            { status: 200 },
          ),
        )
      }

      if (url === "https://api.githubcopilot.com/models/session/intent") {
        intentBody = JSON.parse(String(init?.body))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              predicted_label: "no_reasoning",
              confidence: 1,
              latency_ms: 14,
              chosen_model: "claude-sonnet-4.6",
              candidate_models: ["claude-sonnet-4.6", "gpt-4o"],
              sticky_override: false,
              routing_method: "binary",
              fallback: false,
            }),
            { status: 200 },
          ),
        )
      }

      return Promise.reject(new Error(`unexpected url: ${url}`))
    }) as never,
    headers: () => ({ Authorization: "Bearer copilot-token" }),
    createModel: mock(() => ({ doGenerate: mock(() => Promise.resolve({} as never)), doStream: mock() })) as never,
  })

  await model.doGenerate({
    prompt: [
      {
        role: "system",
        content: [{ type: "text", text: "You are editing a TypeScript repo." }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Earlier request about refactoring the parser." }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "I suggested a minimal patch and asked about tests." }],
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Fix the failing stack trace in build output and update the diff parser.```diff\n- old\n+ new\n```",
          },
          { type: "file", mediaType: "application/pdf", data: "ignored" },
        ],
      },
    ],
    tools: [{ type: "function", name: "read_file" }],
    toolChoice: "required",
  } as never)

  expect(intentBody).toBeDefined()
  expect(intentBody?.prompt).toContain("Latest user request:")
  expect(intentBody?.prompt).toContain("Fix the failing stack trace in build output")
  expect(intentBody?.prompt).toContain("Task:")
  expect(intentBody?.prompt).toContain("Tool choice: required")
  expect(intentBody?.prompt).toContain("Available tools: 1")
  expect(intentBody?.prompt).toContain("Includes files: yes")
  expect(intentBody?.prompt).toContain("Includes diff: yes")
  expect(intentBody?.prompt).toContain("Includes stack traces: yes")
  expect(intentBody?.prompt).toContain("Earlier context:")
  expect(intentBody?.prompt).toContain("system: You are editing a TypeScript repo.")
  expect(intentBody?.prompt).toContain("assistant: I suggested a minimal patch")
})

test("trims routing prompt by section priority instead of blunt slicing", async () => {
  let intentBody: Record<string, unknown> | undefined
  const model = createCopilotAutoModel({
    baseURL: "https://api.githubcopilot.com",
    fetch: mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url

      if (url === "https://api.githubcopilot.com/models/session") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              available_models: ["gpt-5.3-codex", "claude-sonnet-4.6", "gpt-4o"],
              selected_model: "gpt-5.3-codex",
              session_token: "session-token",
              expires_at: Math.floor(Date.now() / 1000) + 1800,
            }),
            { status: 200 },
          ),
        )
      }

      if (url === "https://api.githubcopilot.com/models/session/intent") {
        intentBody = JSON.parse(String(init?.body))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              predicted_label: "no_reasoning",
              confidence: 1,
              latency_ms: 14,
              chosen_model: "claude-sonnet-4.6",
              candidate_models: ["claude-sonnet-4.6", "gpt-4o"],
              sticky_override: false,
              routing_method: "binary",
              fallback: false,
            }),
            { status: 200 },
          ),
        )
      }

      return Promise.reject(new Error(`unexpected url: ${url}`))
    }) as never,
    headers: () => ({ Authorization: "Bearer copilot-token" }),
    createModel: mock(() => ({ doGenerate: mock(() => Promise.resolve({} as never)), doStream: mock() })) as never,
  })

  await model.doGenerate({
    prompt: [
      {
        role: "user",
        content: [{ type: "text", text: `EARLY:${"old context ".repeat(6000)}` }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: `ASSISTANT:${"assistant context ".repeat(4000)}` }],
      },
      {
        role: "user",
        content: [{ type: "text", text: `LATEST:${"critical latest request ".repeat(1200)}` }],
      },
    ],
  } as never)

  expect(intentBody).toBeDefined()
  expect(typeof intentBody?.prompt).toBe("string")
  expect((intentBody?.prompt as string).length).toBeLessThanOrEqual(32768)
  expect(intentBody?.prompt).toContain("LATEST:")
  expect(intentBody?.prompt).not.toContain(
    "EARLY:old context old context old context old context old context old context old context old context old context old context old context old context old context old context old context old context",
  )
})
