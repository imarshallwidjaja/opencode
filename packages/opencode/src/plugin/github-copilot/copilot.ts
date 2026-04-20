import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { Model } from "@opencode-ai/sdk/v2"
import { InstallationVersion } from "@/installation/version"
import { CopilotHeaders } from "@/provider/sdk/copilot/headers"
import { iife } from "@/util/iife"
import { Log } from "../../util"
import { setTimeout as sleep } from "node:timers/promises"
import { CopilotModels } from "./models"
import { MessageV2 } from "@/session/message-v2"

const log = Log.create({ service: "plugin.copilot" })

const CLIENT_ID = "01ab8ac9400c4e429b23"
const COPILOT_OAUTH_SCOPES = ["read:user", "user:email", "repo", "workflow"] as const
const GITHUB_API_VERSION = "2022-11-28"
// Add a small safety buffer when polling to avoid hitting the server
// slightly too early due to clock skew / timer drift.
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000 // 3 seconds
const COPILOT_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000

type CopilotOAuthAuth = {
  type: "oauth"
  refresh: string
  access: string
  expires: number
  githubToken?: string
  githubScopes?: string[]
  enterpriseUrl?: string
}

type CopilotTokenEnvelope = {
  token: string
  expires_at?: number
  refresh_in?: number
}

function normalizeDomain(url: string) {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "")
}

function getUrls(domain: string) {
  return {
    DEVICE_CODE_URL: `https://${domain}/login/device/code`,
    ACCESS_TOKEN_URL: `https://${domain}/login/oauth/access_token`,
  }
}

function getDotcomApiUrl(enterpriseUrl?: string) {
  if (!enterpriseUrl) return "https://api.github.com"
  return `https://api.${normalizeDomain(enterpriseUrl)}`
}

function base(enterpriseUrl?: string) {
  return enterpriseUrl ? `https://copilot-api.${normalizeDomain(enterpriseUrl)}` : "https://api.githubcopilot.com"
}

function getLegacyGithubToken(auth: CopilotOAuthAuth) {
  if (auth.githubToken) return auth.githubToken
  if (auth.expires === 0) return auth.refresh
}

function normalizeScopes(scopes?: string | string[]) {
  const values = Array.isArray(scopes) ? scopes : typeof scopes === "string" ? scopes.split(/[\s,]+/) : []
  return [...new Set(values.map((scope) => scope.trim()).filter(Boolean))]
}

function getMissingScopes(scopes: readonly string[]) {
  return COPILOT_OAUTH_SCOPES.filter((scope) => !scopes.includes(scope))
}

function getScopeError(scopes: readonly string[]) {
  const missing = getMissingScopes(scopes)
  if (missing.length === 0) return
  return [
    "Re-authenticate GitHub Copilot.",
    `The stored GitHub token is missing required scopes: ${missing.join(", ")}.`,
    `Granted scopes: ${scopes.length ? scopes.join(", ") : "none"}.`,
  ].join(" ")
}

async function fetchGithubScopes(githubToken: string, enterpriseUrl?: string) {
  const response = await fetch(`${getDotcomApiUrl(enterpriseUrl)}/user`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${githubToken}`,
      "User-Agent": `opencode/${InstallationVersion}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    },
  })

  if (!response.ok) {
    throw new Error(`Failed to inspect GitHub token scopes: ${response.status}`)
  }

  return normalizeScopes(response.headers.get("x-oauth-scopes") ?? undefined)
}

function isTokenFresh(expiresAt: number) {
  return expiresAt > Date.now() + COPILOT_TOKEN_REFRESH_BUFFER_MS
}

async function exchangeForCopilotToken(githubToken: string, enterpriseUrl?: string): Promise<CopilotTokenEnvelope> {
  const response = await fetch(`${getDotcomApiUrl(enterpriseUrl)}/copilot_internal/v2/token`, {
    headers: {
      Authorization: `token ${githubToken}`,
      "User-Agent": `opencode/${InstallationVersion}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    },
  })

  const payload = (await response.json().catch(() => undefined)) as
    | CopilotTokenEnvelope
    | { message?: string }
    | undefined
  if (!response.ok) {
    const message = payload && "message" in payload && typeof payload.message === "string" ? payload.message : undefined
    throw new Error(
      `Failed to exchange GitHub token for Copilot token: ${response.status}${message ? ` ${message}` : ""}`,
    )
  }

  if (!payload || typeof payload !== "object" || !("token" in payload) || typeof payload.token !== "string") {
    throw new Error("Failed to exchange GitHub token for Copilot token: invalid response")
  }

  return payload satisfies CopilotTokenEnvelope
}

function getCopilotTokenExpiry(payload: CopilotTokenEnvelope) {
  if (typeof payload.refresh_in === "number") return Date.now() + (payload.refresh_in + 60) * 1000
  if (typeof payload.expires_at === "number") return payload.expires_at * 1000
  return Date.now() + 30 * 60 * 1000
}

// Check if a message is a synthetic user msg used to attach an image from a tool call
function imgMsg(msg: any): boolean {
  if (msg?.role !== "user") return false

  // Handle the 3 api formats

  const content = msg.content
  if (typeof content === "string") return content === MessageV2.SYNTHETIC_ATTACHMENT_PROMPT
  if (!Array.isArray(content)) return false
  return content.some(
    (part: any) =>
      (part?.type === "text" || part?.type === "input_text") && part.text === MessageV2.SYNTHETIC_ATTACHMENT_PROMPT,
  )
}

function fix(model: Model, url: string): Model {
  return {
    ...model,
    api: {
      ...model.api,
      url,
      npm: "@ai-sdk/github-copilot",
    },
  }
}

function withAutoModel(models: Record<string, Model>, baseURL: string): Record<string, Model> {
  return {
    ...models,
    // Add the virtual auto model that routes requests via Copilot's model selector APIs.
    auto: {
      id: "auto" as any,
      providerID: "github-copilot" as any,
      name: "Auto (Best for task)",
      family: "auto",
      api: {
        id: "auto",
        url: baseURL,
        npm: "@ai-sdk/github-copilot",
      },
      status: "active",
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 128000, output: 16384 },
      options: {},
      headers: {},
      release_date: "",
      variants: {},
    },
  }
}

export async function CopilotAuthPlugin(input: PluginInput): Promise<Hooks> {
  const sdk = input.client
  let cachedToken:
    | {
        githubToken: string
        token: string
        expiresAt: number
      }
    | undefined

  async function getBearerToken(auth: CopilotOAuthAuth) {
    if (auth.githubToken && auth.access && isTokenFresh(auth.expires)) {
      cachedToken = {
        githubToken: auth.githubToken,
        token: auth.access,
        expiresAt: auth.expires,
      }
      return auth.access
    }

    const githubToken = getLegacyGithubToken(auth)
    if (!githubToken) {
      if (auth.access && auth.expires !== 0 && isTokenFresh(auth.expires)) return auth.access
      throw new Error("Re-authenticate GitHub Copilot. No refreshable GitHub token is stored.")
    }

    const githubScopes = auth.githubScopes?.length
      ? auth.githubScopes
      : await fetchGithubScopes(githubToken, auth.enterpriseUrl)
    const scopeError = getScopeError(githubScopes)
    if (scopeError) throw new Error(scopeError)

    if (cachedToken && cachedToken.githubToken === githubToken && isTokenFresh(cachedToken.expiresAt)) {
      return cachedToken.token
    }

    const token = await exchangeForCopilotToken(githubToken, auth.enterpriseUrl)
    cachedToken = {
      githubToken,
      token: token.token,
      expiresAt: getCopilotTokenExpiry(token),
    }
    return cachedToken.token
  }

  return {
    provider: {
      id: "github-copilot",
      async models(provider, ctx) {
        if (ctx.auth?.type !== "oauth") {
          return withAutoModel(
            Object.fromEntries(Object.entries(provider.models).map(([id, model]) => [id, fix(model, base())])),
            base(),
          )
        }

        const auth = ctx.auth
        const bearerToken = await getBearerToken(auth)

        return CopilotModels.get(
          base(auth.enterpriseUrl),
          CopilotHeaders.getCopilotCapiHeaders(bearerToken),
          provider.models,
        )
          .then((models) => withAutoModel(models, base(auth.enterpriseUrl)))
          .catch((error) => {
            log.error("failed to fetch copilot models", { error })
            return withAutoModel(
              Object.fromEntries(
                Object.entries(provider.models).map(([id, model]) => [id, fix(model, base(auth.enterpriseUrl))]),
              ),
              base(auth.enterpriseUrl),
            )
          })
      },
    },
    auth: {
      provider: "github-copilot",
      async loader(getAuth) {
        const info = await getAuth()
        if (!info || info.type !== "oauth") return {}

        return {
          apiKey: "",
          async fetch(request: RequestInfo | URL, init?: RequestInit) {
            const info = await getAuth()
            if (info.type !== "oauth") return fetch(request, init)
            const bearerToken = await getBearerToken(info)

            const url = request instanceof URL ? request.href : typeof request === "string" ? request : request.url
            const { isVision, isAgent } = iife(() => {
              try {
                const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body

                // Completions API
                if (body?.messages && url.includes("completions")) {
                  const last = body.messages[body.messages.length - 1]
                  return {
                    isVision: body.messages.some(
                      (msg: any) =>
                        Array.isArray(msg.content) && msg.content.some((part: any) => part.type === "image_url"),
                    ),
                    isAgent: last?.role !== "user" || imgMsg(last),
                  }
                }

                // Responses API
                if (body?.input) {
                  const last = body.input[body.input.length - 1]
                  return {
                    isVision: body.input.some(
                      (item: any) =>
                        Array.isArray(item?.content) && item.content.some((part: any) => part.type === "input_image"),
                    ),
                    isAgent: last?.role !== "user" || imgMsg(last),
                  }
                }

                // Messages API
                if (body?.messages) {
                  const last = body.messages[body.messages.length - 1]
                  const hasNonToolCalls =
                    Array.isArray(last?.content) && last.content.some((part: any) => part?.type !== "tool_result")
                  return {
                    isVision: body.messages.some(
                      (item: any) =>
                        Array.isArray(item?.content) &&
                        item.content.some(
                          (part: any) =>
                            part?.type === "image" ||
                            // images can be nested inside tool_result content
                            (part?.type === "tool_result" &&
                              Array.isArray(part?.content) &&
                              part.content.some((nested: any) => nested?.type === "image")),
                        ),
                    ),
                    isAgent: !(last?.role === "user" && hasNonToolCalls) || imgMsg(last),
                  }
                }
              } catch {}
              return { isVision: false, isAgent: false }
            })

            const headers = CopilotHeaders.getCopilotCapiHeaders(bearerToken, {
              "x-initiator": isAgent ? "agent" : "user",
              ...(init?.headers as Record<string, string>),
              "Openai-Intent": "conversation-edits",
            })

            if (isVision) {
              headers["Copilot-Vision-Request"] = "true"
            }

            delete headers["x-api-key"]
            delete headers["authorization"]

            return fetch(request, {
              ...init,
              headers,
            })
          },
        }
      },
      methods: [
        {
          type: "oauth",
          label: "Login with GitHub Copilot",
          prompts: [
            {
              type: "select",
              key: "deploymentType",
              message: "Select GitHub deployment type",
              options: [
                {
                  label: "GitHub.com",
                  value: "github.com",
                  hint: "Public",
                },
                {
                  label: "GitHub Enterprise",
                  value: "enterprise",
                  hint: "Data residency or self-hosted",
                },
              ],
            },
            {
              type: "text",
              key: "enterpriseUrl",
              message: "Enter your GitHub Enterprise URL or domain",
              placeholder: "company.ghe.com or https://company.ghe.com",
              when: { key: "deploymentType", op: "eq", value: "enterprise" },
              validate: (value) => {
                if (!value) return "URL or domain is required"
                try {
                  const url = value.includes("://") ? new URL(value) : new URL(`https://${value}`)
                  if (!url.hostname) return "Please enter a valid URL or domain"
                  return undefined
                } catch {
                  return "Please enter a valid URL (e.g., company.ghe.com or https://company.ghe.com)"
                }
              },
            },
          ],
          async authorize(inputs = {}) {
            const deploymentType = inputs.deploymentType || "github.com"

            let domain = "github.com"

            if (deploymentType === "enterprise") {
              const enterpriseUrl = inputs.enterpriseUrl
              domain = normalizeDomain(enterpriseUrl!)
            }

            const urls = getUrls(domain)

            const deviceResponse = await fetch(urls.DEVICE_CODE_URL, {
              method: "POST",
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "User-Agent": `opencode/${InstallationVersion}`,
              },
              body: JSON.stringify({
                client_id: CLIENT_ID,
                scope: COPILOT_OAUTH_SCOPES.join(" "),
              }),
            })

            if (!deviceResponse.ok) {
              throw new Error("Failed to initiate device authorization")
            }

            const deviceData = (await deviceResponse.json()) as {
              verification_uri: string
              user_code: string
              device_code: string
              interval: number
            }

            return {
              url: deviceData.verification_uri,
              instructions: `Enter code: ${deviceData.user_code}`,
              method: "auto" as const,
              async callback() {
                while (true) {
                  const response = await fetch(urls.ACCESS_TOKEN_URL, {
                    method: "POST",
                    headers: {
                      Accept: "application/json",
                      "Content-Type": "application/json",
                      "User-Agent": `opencode/${InstallationVersion}`,
                    },
                    body: JSON.stringify({
                      client_id: CLIENT_ID,
                      device_code: deviceData.device_code,
                      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                    }),
                  })

                  if (!response.ok) return { type: "failed" as const }

                  const data = (await response.json()) as {
                    access_token?: string
                    error?: string
                    interval?: number
                    scope?: string
                  }

                  if (data.access_token) {
                    const githubToken = data.access_token
                    const result: {
                      type: "success"
                      refresh: string
                      access: string
                      expires: number
                      githubToken?: string
                      githubScopes?: string[]
                      provider?: string
                      enterpriseUrl?: string
                    } = {
                      type: "success",
                      refresh: githubToken,
                      access: githubToken,
                      expires: 0,
                    }

                    const githubScopes = normalizeScopes(data.scope)
                    const scopeError = getScopeError(githubScopes)
                    if (scopeError) throw new Error(scopeError)

                    const copilotToken = await exchangeForCopilotToken(
                      githubToken,
                      deploymentType === "enterprise" ? domain : undefined,
                    )
                    result.access = copilotToken.token
                    result.expires = getCopilotTokenExpiry(copilotToken)
                    result.githubToken = githubToken
                    result.githubScopes = githubScopes

                    if (deploymentType === "enterprise") {
                      result.enterpriseUrl = domain
                    }

                    return result
                  }

                  if (data.error === "authorization_pending") {
                    await sleep(deviceData.interval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS)
                    continue
                  }

                  if (data.error === "slow_down") {
                    // Based on the RFC spec, we must add 5 seconds to our current polling interval.
                    // (See https://www.rfc-editor.org/rfc/rfc8628#section-3.5)
                    let newInterval = (deviceData.interval + 5) * 1000

                    // GitHub OAuth API may return the new interval in seconds in the response.
                    // We should try to use that if provided with safety margin.
                    const serverInterval = data.interval
                    if (serverInterval && typeof serverInterval === "number" && serverInterval > 0) {
                      newInterval = serverInterval * 1000
                    }

                    await sleep(newInterval + OAUTH_POLLING_SAFETY_MARGIN_MS)
                    continue
                  }

                  if (data.error) return { type: "failed" as const }

                  await sleep(deviceData.interval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS)
                  continue
                }
              },
            }
          },
        },
      ],
    },
    "chat.params": async (incoming, output) => {
      if (!incoming.model.providerID.includes("github-copilot")) return

      // Match github copilot cli, omit maxOutputTokens for gpt models
      if (incoming.model.api.id.includes("gpt")) {
        output.maxOutputTokens = undefined
      }

      // GitHub Copilot's /v1/messages shim rejects the GA `eager_input_streaming`
      // field on tool definitions ("Extra inputs are not permitted"). Opt out of
      // the @ai-sdk/anthropic default so it stops injecting the field.
      if (incoming.model.api.npm === "@ai-sdk/anthropic") {
        output.options.toolStreaming = false
      }
    },
    "chat.headers": async (incoming, output) => {
      if (!incoming.model.providerID.includes("github-copilot")) return

      if (incoming.model.api.npm === "@ai-sdk/anthropic") {
        output.headers["anthropic-beta"] = "interleaved-thinking-2025-05-14"
      }

      const parts = await sdk.session
        .message({
          path: {
            id: incoming.message.sessionID,
            messageID: incoming.message.id,
          },
          query: {
            directory: input.directory,
          },
          throwOnError: true,
        })
        .catch(() => undefined)

      if (
        parts?.data.parts?.some(
          (part) =>
            part.type === "compaction" ||
            // Auto-compaction resumes via a synthetic user text part. Treat only
            // that marked followup as agent-initiated so manual prompts stay user-initiated.
            (part.type === "text" && part.synthetic && part.metadata?.compaction_continue === true),
        )
      ) {
        output.headers["x-initiator"] = "agent"
        return
      }

      const session = await sdk.session
        .get({
          path: {
            id: incoming.sessionID,
          },
          query: {
            directory: input.directory,
          },
          throwOnError: true,
        })
        .catch(() => undefined)
      if (!session || !session.data.parentID) return
      // mark subagent sessions as agent initiated matching standard that other copilot tools have
      output.headers["x-initiator"] = "agent"
    },
  }
}
