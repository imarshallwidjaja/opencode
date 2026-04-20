import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
  SharedV3ProviderMetadata,
} from "@ai-sdk/provider"
import type { FetchFunction } from "@ai-sdk/provider-utils"
import { Log } from "@/util"

const log = Log.create({ service: "copilot-auto" })

// 5 minutes before expiry, refresh the session token
const SESSION_REFRESH_BUFFER_MS = 5 * 60 * 1000
const ROUTING_PROMPT_BUDGET = 32 * 1024
const ROUTING_SUMMARY_LINE_BUDGET = 240

type PromptMessage = LanguageModelV3CallOptions["prompt"][number]
type GenerateResult = Awaited<ReturnType<LanguageModelV3["doGenerate"]>>
type StreamResult = Awaited<ReturnType<LanguageModelV3["doStream"]>>

export interface CopilotAutoModelSession {
  availableModels: string[]
  sessionToken: string
  expiresAt: number
  discountedCosts?: Record<string, number>
}

interface CopilotAutoModelOptions {
  baseURL: string
  fetch: FetchFunction
  headers: () => Record<string, string | undefined>
  createModel: (modelId: string, extraHeaders?: Record<string, string>) => LanguageModelV3
}

function getTextParts(message: PromptMessage): string[] {
  if (!Array.isArray(message.content)) return []
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
}

function getMessageText(message: PromptMessage): string {
  return getTextParts(message).join("\n").trim()
}

function getFileParts(message: PromptMessage) {
  if (!Array.isArray(message.content)) return []
  return message.content.flatMap((part) => (part.type === "file" ? [part] : []))
}

function trimMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars <= 0) return ""
  if (maxChars <= 32) return text.slice(0, maxChars)

  const marker = "\n...[truncated]...\n"
  const keep = Math.max(0, maxChars - marker.length)
  const start = Math.ceil(keep / 2)
  const end = Math.floor(keep / 2)
  return `${text.slice(0, start)}${marker}${text.slice(text.length - end)}`
}

function classifyTask(latestUserText: string, toolCount: number): string {
  const lower = latestUserText.toLowerCase()
  if (/(^|\b)(review|audit)(\b|$)/.test(lower)) return "review"
  if (/(^|\b)(debug|error|exception|traceback|stack trace|failing|failure|bug)(\b|$)/.test(lower)) return "debugging"
  if (/(^|\b)(plan|design|brainstorm|approach|architecture)(\b|$)/.test(lower)) return "planning"
  if (/(^|\b)(explain|why|what does|how does)(\b|$)/.test(lower)) return "explanation"
  if (toolCount > 0) return "tool-using coding"
  if (/(^|\b)(fix|implement|refactor|update|add|edit|change|write|build)(\b|$)/.test(lower)) return "coding"
  return "general"
}

function summarizeEarlierMessage(message: PromptMessage): string {
  const text = trimMiddle(getMessageText(message).replace(/\s+/g, " "), ROUTING_SUMMARY_LINE_BUDGET)
  const files = getFileParts(message)
  const imageCount = files.filter((part) => part.mediaType.startsWith("image/")).length
  const fileSummary =
    files.length === 0 ? "" : ` [files: ${files.length}${imageCount ? `, images: ${imageCount}` : ""}]`
  const body = text || "[no text]"
  return `${message.role}: ${body}${fileSummary}`
}

function countTools(tools: LanguageModelV3CallOptions["tools"]): number {
  if (!tools) return 0
  if (Array.isArray(tools)) return tools.length
  return Object.keys(tools).length
}

function getRawPromptCharCount(options: LanguageModelV3CallOptions): number {
  return options.prompt.reduce(
    (total, message) => total + getTextParts(message).reduce((sum, part) => sum + part.length, 0),
    0,
  )
}

function withResolvedModelMetadata(
  providerMetadata: SharedV3ProviderMetadata | undefined,
  resolvedModelId: string,
): SharedV3ProviderMetadata {
  return {
    ...providerMetadata,
    opencode: {
      ...(providerMetadata?.opencode ?? {}),
      modelId: resolvedModelId,
    },
  }
}

function withResolvedModelResult(result: GenerateResult, resolvedModelId: string): GenerateResult {
  return {
    ...result,
    providerMetadata: withResolvedModelMetadata(result.providerMetadata, resolvedModelId),
  }
}

function withResolvedModelStream(result: StreamResult, resolvedModelId: string): StreamResult {
  return {
    ...result,
    stream: result.stream.pipeThrough(
      new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
        transform(part, controller) {
          controller.enqueue({
            ...part,
            providerMetadata: withResolvedModelMetadata(
              "providerMetadata" in part ? part.providerMetadata : undefined,
              resolvedModelId,
            ),
          } as LanguageModelV3StreamPart)
        },
      }),
    ),
  }
}

class CopilotResolvedLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3"
  readonly modelId: LanguageModelV3["modelId"]
  readonly provider: LanguageModelV3["provider"]
  readonly supportsStructuredOutputs = false

  constructor(
    private readonly model: LanguageModelV3,
    private readonly resolvedModelId: string,
  ) {
    this.modelId = model.modelId
    this.provider = model.provider
  }

  get supportedUrls() {
    return this.model.supportedUrls
  }

  async doGenerate(options: LanguageModelV3CallOptions) {
    return withResolvedModelResult(await this.model.doGenerate(options), this.resolvedModelId)
  }

  async doStream(options: LanguageModelV3CallOptions) {
    return withResolvedModelStream(await this.model.doStream(options), this.resolvedModelId)
  }
}

function wrapResolvedModel(model: LanguageModelV3, resolvedModelId: string): LanguageModelV3 {
  return new CopilotResolvedLanguageModel(model, resolvedModelId)
}

function compileRoutingPrompt(options: LanguageModelV3CallOptions): string {
  const latestUserIndex = options.prompt.findLastIndex((message) => message.role === "user")
  const latestUser = latestUserIndex === -1 ? undefined : options.prompt[latestUserIndex]
  const latestUserText = latestUser ? getMessageText(latestUser) : ""
  const toolCount = countTools(options.tools)
  const allFiles = options.prompt.flatMap(getFileParts)
  const imageCount = allFiles.filter((part) => part.mediaType.startsWith("image/")).length
  const conversationTurns = options.prompt.length
  const task = classifyTask(latestUserText, toolCount)
  const containsCodeBlock = /```|`[^`]+`/.test(latestUserText)
  const containsDiff = /```diff|^[-+]{1}[^-+]/m.test(latestUserText)
  const containsStackTrace = /(stack trace|traceback|exception|error:|\s+at\s+.+\(.+\))/i.test(latestUserText)
  const metadataSection = [
    "Routing metadata:",
    `Task: ${task}`,
    `Conversation turns: ${conversationTurns}`,
    `Available tools: ${toolCount}`,
    `Tool choice: ${options.toolChoice ?? "auto"}`,
    `Includes files: ${allFiles.length > 0 ? "yes" : "no"}`,
    `Includes images: ${imageCount > 0 ? "yes" : "no"}`,
    `Includes code blocks: ${containsCodeBlock ? "yes" : "no"}`,
    `Includes diff: ${containsDiff ? "yes" : "no"}`,
    `Includes stack traces: ${containsStackTrace ? "yes" : "no"}`,
  ].join("\n")
  const latestSectionTitle = "Latest user request:\n"
  const latestSection = `${latestSectionTitle}${latestUserText || "[no user text]"}`
  const earlierMessages = options.prompt
    .filter((_, index) => index !== latestUserIndex)
    .map(summarizeEarlierMessage)
    .filter(Boolean)
  const earlierSectionTitle = "Earlier context:\n"
  const earlierSection = earlierMessages.length === 0 ? "" : `${earlierSectionTitle}${earlierMessages.join("\n")}`
  const withEarlier = [metadataSection, latestSection, earlierSection].filter(Boolean).join("\n\n")
  if (withEarlier.length <= ROUTING_PROMPT_BUDGET) return withEarlier

  const withoutEarlier = [metadataSection, latestSection].join("\n\n")
  if (withoutEarlier.length <= ROUTING_PROMPT_BUDGET) return withoutEarlier

  const latestBodyBudget = Math.max(
    512,
    ROUTING_PROMPT_BUDGET - metadataSection.length - "\n\n".length - latestSectionTitle.length,
  )
  return [
    metadataSection,
    `${latestSectionTitle}${trimMiddle(latestUserText || "[no user text]", latestBodyBudget)}`,
  ].join("\n\n")
}

function hasImageContent(options: LanguageModelV3CallOptions): boolean {
  for (const msg of options.prompt) {
    if (msg.role !== "user") continue
    for (const part of msg.content) {
      if (part.type === "file" && part.mediaType.startsWith("image/")) return true
    }
  }
  return false
}

/**
 * CopilotAutoLanguageModel implements LanguageModelV3 and automatically
 * selects the best model for each request using GitHub Copilot's
 * /models/session and /models/session/intent APIs.
 *
 * Protocol (reverse-engineered from VS Code Copilot Chat extension):
 *
 * 1. POST /models/session  - creates an auto-mode session, returns
 *    available_models, session_token, expires_at, discounted_costs
 *
 * 2. POST /models/session/intent  - per-turn routing, sends prompt text
 *    and available models. The session_token is passed via the
 *    Copilot-Session-Token header. Returns candidate_models ranked by
 *    suitability.
 *
 * 3. The selected model's chat/responses request also receives the
 *    Copilot-Session-Token header for billing discount tracking.
 */
export class CopilotAutoLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3"
  readonly modelId = "auto"
  readonly provider = "github-copilot.auto"
  readonly supportsStructuredOutputs = false

  private session: CopilotAutoModelSession | null = null
  private lastModelId: string | null = null
  private lastPrompt: string | null = null
  private turnNumber = 0
  private readonly options: CopilotAutoModelOptions

  constructor(options: CopilotAutoModelOptions) {
    this.options = options
  }

  get supportedUrls() {
    return {}
  }

  private isSessionExpired(): boolean {
    if (!this.session) return true
    return Date.now() >= this.session.expiresAt * 1000 - SESSION_REFRESH_BUFFER_MS
  }

  private async ensureSession(): Promise<CopilotAutoModelSession> {
    if (this.session && !this.isSessionExpired()) return this.session

    const url = `${this.options.baseURL}/models/session`
    log.info("creating auto model session", { url })

    const headers = this.options.headers()
    const response = await this.options.fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify({
        auto_mode: {
          model_hints: ["auto"],
        },
      }),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Failed to create auto model session: ${response.status} ${text}`)
    }

    const data = (await response.json()) as {
      available_models: string[]
      session_token: string
      expires_at: number
      discounted_costs?: Record<string, number>
    }

    if (
      !Array.isArray(data.available_models) ||
      data.available_models.length === 0 ||
      typeof data.session_token !== "string" ||
      typeof data.expires_at !== "number"
    ) {
      throw new Error("Failed to create auto model session: invalid response")
    }

    log.info("auto model session created", {
      availableModels: data.available_models,
      expiresAt: data.expires_at,
    })

    this.session = {
      availableModels: data.available_models,
      sessionToken: data.session_token,
      expiresAt: data.expires_at,
      discountedCosts: data.discounted_costs,
    }

    return this.session
  }

  private async resolveModel(callOptions: LanguageModelV3CallOptions): Promise<LanguageModelV3> {
    const session = await this.ensureSession()
    const promptText = compileRoutingPrompt(callOptions)
    const promptCharCount = getRawPromptCharCount(callOptions)
    const sessionHeaders = { "Copilot-Session-Token": session.sessionToken }

    // Skip router for image requests, VS Code falls back to vision-capable model selection
    if (hasImageContent(callOptions)) {
      const fallbackModelId = session.availableModels[0]
      log.info("auto model skipping router for image request", { modelId: fallbackModelId })
      this.lastModelId = fallbackModelId
      return wrapResolvedModel(this.options.createModel(fallbackModelId, sessionHeaders), fallbackModelId)
    }

    // Same prompt as last turn, reuse previous decision
    if (promptText && promptText === this.lastPrompt && this.lastModelId) {
      log.info("auto model reusing previous routing", { modelId: this.lastModelId })
      return wrapResolvedModel(this.options.createModel(this.lastModelId, sessionHeaders), this.lastModelId)
    }

    this.turnNumber++
    this.lastPrompt = promptText

    const url = `${this.options.baseURL}/models/session/intent`
    log.info("routing auto model", {
      turnNumber: this.turnNumber,
      promptLength: promptText.length,
      availableModels: session.availableModels,
    })

    const headers = this.options.headers()
    const response = await this.options.fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Copilot-Session-Token": session.sessionToken,
        ...headers,
      },
      body: JSON.stringify({
        prompt: promptText,
        available_models: session.availableModels,
        turn_number: this.turnNumber,
        previous_model: this.lastModelId,
        prompt_char_count: promptCharCount,
        reference_count: 0,
        session_id: undefined,
        sticky_threshold: undefined,
      }),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Failed to route auto model session: ${response.status} ${text}`)
    }

    const data = (await response.json()) as {
      predicted_label?: string
      confidence?: number
      candidate_models?: string[]
      sticky_override?: boolean
    }
    if (!Array.isArray(data.candidate_models) || data.candidate_models.length === 0) {
      throw new Error("Failed to route auto model session: no candidate models returned")
    }

    const selectedModelId = data.candidate_models[0]
    log.info("auto model selected", {
      modelId: selectedModelId,
      predictedLabel: data.predicted_label,
      confidence: data.confidence,
      stickyOverride: data.sticky_override,
    })
    this.lastModelId = selectedModelId
    return wrapResolvedModel(this.options.createModel(selectedModelId, sessionHeaders), selectedModelId)
  }

  async doGenerate(options: LanguageModelV3CallOptions) {
    const model = await this.resolveModel(options)
    return model.doGenerate(options)
  }

  async doStream(options: LanguageModelV3CallOptions) {
    const model = await this.resolveModel(options)
    return model.doStream(options)
  }
}

export function createCopilotAutoModel(options: CopilotAutoModelOptions): LanguageModelV3 {
  return new CopilotAutoLanguageModel(options)
}
