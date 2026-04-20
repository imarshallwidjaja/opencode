import { afterEach, expect, mock, test } from "bun:test"
import { CopilotModels } from "@/plugin/github-copilot/models"
import { CopilotAuthPlugin } from "@/plugin/github-copilot/copilot"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test("preserves temperature support from existing provider models", async () => {
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data: [
            {
              model_picker_enabled: true,
              id: "gpt-4o",
              name: "GPT-4o",
              version: "gpt-4o-2024-05-13",
              capabilities: {
                family: "gpt",
                limits: {
                  max_context_window_tokens: 64000,
                  max_output_tokens: 16384,
                  max_prompt_tokens: 64000,
                },
                supports: {
                  streaming: true,
                  tool_calls: true,
                },
              },
            },
            {
              model_picker_enabled: true,
              id: "brand-new",
              name: "Brand New",
              version: "brand-new-2026-04-01",
              capabilities: {
                family: "test",
                limits: {
                  max_context_window_tokens: 32000,
                  max_output_tokens: 8192,
                  max_prompt_tokens: 32000,
                },
                supports: {
                  streaming: true,
                  tool_calls: false,
                },
              },
            },
          ],
        }),
        { status: 200 },
      ),
    ),
  ) as unknown as typeof fetch

  const models = await CopilotModels.get(
    "https://api.githubcopilot.com",
    {},
    {
      "gpt-4o": {
        id: "gpt-4o",
        providerID: "github-copilot",
        api: {
          id: "gpt-4o",
          url: "https://api.githubcopilot.com",
          npm: "@ai-sdk/openai-compatible",
        },
        name: "GPT-4o",
        family: "gpt",
        capabilities: {
          temperature: true,
          reasoning: false,
          attachment: true,
          toolcall: true,
          input: {
            text: true,
            audio: false,
            image: true,
            video: false,
            pdf: false,
          },
          output: {
            text: true,
            audio: false,
            image: false,
            video: false,
            pdf: false,
          },
          interleaved: false,
        },
        cost: {
          input: 0,
          output: 0,
          cache: {
            read: 0,
            write: 0,
          },
        },
        limit: {
          context: 64000,
          output: 16384,
        },
        options: {},
        headers: {},
        release_date: "2024-05-13",
        variants: {},
        status: "active",
      },
    },
  )

  expect(models["gpt-4o"].capabilities.temperature).toBe(true)
  expect(models["brand-new"].capabilities.temperature).toBe(true)
})

test("skips incomplete non-chat models from the remote list", async () => {
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data: [
            {
              model_picker_enabled: true,
              id: "gpt-4o",
              name: "GPT-4o",
              version: "gpt-4o-2024-05-13",
              capabilities: {
                family: "gpt",
                type: "chat",
                limits: {
                  max_context_window_tokens: 64000,
                  max_output_tokens: 16384,
                  max_prompt_tokens: 64000,
                },
                supports: {
                  streaming: true,
                  tool_calls: true,
                },
              },
            },
            {
              model_picker_enabled: false,
              id: "text-embedding-3-small",
              name: "text-embedding-3-small",
              version: "text-embedding-3-small",
              capabilities: {
                family: "text-embedding-3-small",
                type: "embeddings",
                limits: {
                  max_inputs: 2048,
                },
                supports: {
                  dimensions: true,
                },
              },
            },
            {
              model_picker_enabled: true,
              id: "gpt-41-copilot",
              name: "GPT-4.1 Copilot",
              version: "gpt-41-copilot",
              capabilities: {
                family: "gpt-4.1",
                type: "chat",
                supports: {
                  streaming: true,
                },
              },
            },
          ],
        }),
        { status: 200 },
      ),
    ),
  ) as unknown as typeof fetch

  const models = await CopilotModels.get("https://api.githubcopilot.com")

  expect(Object.keys(models)).toEqual(["gpt-4o"])
})

test("remaps fallback oauth model urls to the enterprise host", async () => {
  globalThis.fetch = mock(() => Promise.reject(new Error("timeout"))) as unknown as typeof fetch

  const hooks = await CopilotAuthPlugin({
    client: {} as never,
    project: {} as never,
    directory: "",
    worktree: "",
    experimental_workspace: {
      register() {},
    },
    serverUrl: new URL("https://example.com"),
    $: {} as never,
  })

  const models = await hooks.provider!.models!(
    {
      id: "github-copilot",
      models: {
        claude: {
          id: "claude",
          providerID: "github-copilot",
          api: {
            id: "claude-sonnet-4.5",
            url: "https://api.githubcopilot.com/v1",
            npm: "@ai-sdk/anthropic",
          },
        },
      },
    } as never,
    {
      auth: {
        type: "oauth",
        refresh: "token",
        access: "token",
        expires: Date.now() + 10 * 60_000,
        enterpriseUrl: "ghe.example.com",
      } as never,
    },
  )

  expect(models.claude.api.url).toBe("https://copilot-api.ghe.example.com")
  expect(models.claude.api.npm).toBe("@ai-sdk/github-copilot")
})

test("requests Copilot OAuth scopes during device authorization", async () => {
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          verification_uri: "https://github.com/login/device",
          user_code: "ABCD-EFGH",
          device_code: "device-code",
          interval: 5,
        }),
        { status: 200 },
      ),
    ),
  ) as unknown as typeof fetch

  const hooks = await CopilotAuthPlugin({
    client: {} as never,
    project: {} as never,
    directory: "",
    worktree: "",
    experimental_workspace: {
      register() {},
    },
    serverUrl: new URL("https://example.com"),
    $: {} as never,
  })

  await hooks.auth!.methods[0].authorize!()

  expect(globalThis.fetch).toHaveBeenCalledWith(
    "https://github.com/login/device/code",
    expect.objectContaining({
      body: JSON.stringify({
        client_id: "01ab8ac9400c4e429b23",
        scope: "read:user user:email repo workflow",
      }),
    }),
  )
})

test("fails auth callback when Copilot token exchange fails", async () => {
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url

    if (url === "https://github.com/login/device/code") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            verification_uri: "https://github.com/login/device",
            user_code: "ABCD-EFGH",
            device_code: "device-code",
            interval: 0,
          }),
          { status: 200 },
        ),
      )
    }

    if (url === "https://github.com/login/oauth/access_token") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "github-oauth-token",
            scope: "read:user,user:email,repo,workflow",
          }),
          { status: 200 },
        ),
      )
    }

    if (url === "https://api.github.com/copilot_internal/v2/token") {
      return Promise.resolve(new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }))
    }

    return Promise.reject(new Error(`unexpected url: ${url}`))
  }) as unknown as typeof fetch

  const hooks = await CopilotAuthPlugin({
    client: {} as never,
    project: {} as never,
    directory: "",
    worktree: "",
    experimental_workspace: {
      register() {},
    },
    serverUrl: new URL("https://example.com"),
    $: {} as never,
  })

  const result = await hooks.auth!.methods[0].authorize!()
  if (!("callback" in result) || typeof result.callback !== "function") {
    throw new Error("expected OAuth callback result")
  }
  const callback = result.callback as () => Promise<unknown>

  await expect(callback()).rejects.toThrow("Failed to exchange GitHub token for Copilot token: 404 Not Found")
})

test("exchanges legacy GitHub oauth tokens before fetching Copilot models", async () => {
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url

    if (url === "https://api.github.com/copilot_internal/v2/token") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            token: "copilot-token",
            expires_at: Math.floor(Date.now() / 1000) + 1800,
            refresh_in: 1800,
          }),
          { status: 200 },
        ),
      )
    }

    if (url === "https://api.githubcopilot.com/models") {
      return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }))
    }

    return Promise.reject(new Error(`unexpected url: ${url}`))
  }) as unknown as typeof fetch

  const hooks = await CopilotAuthPlugin({
    client: {} as never,
    project: {} as never,
    directory: "",
    worktree: "",
    experimental_workspace: {
      register() {},
    },
    serverUrl: new URL("https://example.com"),
    $: {} as never,
  })

  await hooks.provider!.models!(
    {
      id: "github-copilot",
      models: {},
    } as never,
    {
      auth: {
        type: "oauth",
        refresh: "github-oauth-token",
        access: "github-oauth-token",
        expires: 0,
        githubScopes: ["read:user", "user:email", "repo", "workflow"],
      } as never,
    },
  )

  expect(globalThis.fetch).toHaveBeenCalledWith(
    "https://api.github.com/copilot_internal/v2/token",
    expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: "token github-oauth-token",
        "X-GitHub-Api-Version": "2022-11-28",
      }),
    }),
  )
  expect(globalThis.fetch).toHaveBeenCalledWith(
    "https://api.githubcopilot.com/models",
    expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: "Bearer copilot-token",
        "Copilot-Integration-Id": "vscode-chat",
        "Editor-Plugin-Version": "copilot-chat/0.44.1",
        "Editor-Version": "vscode/1.99.0",
        "X-GitHub-Api-Version": "2025-07-16",
        "x-policy-id": "nil",
      }),
    }),
  )
})

test("rejects legacy GitHub OAuth tokens without the required Copilot scopes", async () => {
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url

    if (url === "https://api.github.com/user") {
      return Promise.resolve(
        new Response(JSON.stringify({ login: "test-user" }), {
          status: 200,
          headers: {
            "X-OAuth-Scopes": "read:user",
          },
        }),
      )
    }

    return Promise.reject(new Error(`unexpected url: ${url}`))
  }) as unknown as typeof fetch

  const hooks = await CopilotAuthPlugin({
    client: {} as never,
    project: {} as never,
    directory: "",
    worktree: "",
    experimental_workspace: {
      register() {},
    },
    serverUrl: new URL("https://example.com"),
    $: {} as never,
  })

  await expect(
    hooks.provider!.models!(
      {
        id: "github-copilot",
        models: {},
      } as never,
      {
        auth: {
          type: "oauth",
          refresh: "github-oauth-token",
          access: "github-oauth-token",
          expires: 0,
        } as never,
      },
    ),
  ).rejects.toThrow("Re-authenticate GitHub Copilot")

  expect(globalThis.fetch).toHaveBeenCalledWith(
    "https://api.github.com/user",
    expect.objectContaining({
      headers: expect.objectContaining({
        "X-GitHub-Api-Version": "2022-11-28",
      }),
    }),
  )
})

test("rejects expired Copilot auth that cannot refresh back to GitHub", async () => {
  globalThis.fetch = mock(() => Promise.reject(new Error("unexpected fetch"))) as unknown as typeof fetch

  const hooks = await CopilotAuthPlugin({
    client: {} as never,
    project: {} as never,
    directory: "",
    worktree: "",
    experimental_workspace: {
      register() {},
    },
    serverUrl: new URL("https://example.com"),
    $: {} as never,
  })

  await expect(
    hooks.provider!.models!(
      {
        id: "github-copilot",
        models: {},
      } as never,
      {
        auth: {
          type: "oauth",
          refresh: "stale-copilot-token",
          access: "stale-copilot-token",
          expires: Date.now() - 60_000,
        } as never,
      },
    ),
  ).rejects.toThrow("No refreshable GitHub token is stored")
})
