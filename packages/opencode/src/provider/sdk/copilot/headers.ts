import { InstallationVersion } from "@/installation/version"

const COPILOT_CAPI_API_VERSION = "2025-07-16"
const COPILOT_EDITOR_VERSION = "vscode/1.99.0"
const COPILOT_EDITOR_PLUGIN_VERSION = "copilot-chat/0.44.1"
const COPILOT_INTEGRATION_ID = "vscode-chat"

export function getCopilotCapiHeaders(token: string, headers: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Copilot-Integration-Id": COPILOT_INTEGRATION_ID,
    "Editor-Plugin-Version": COPILOT_EDITOR_PLUGIN_VERSION,
    "Editor-Version": COPILOT_EDITOR_VERSION,
    "User-Agent": `GitHubCopilotChat/${InstallationVersion}`,
    "X-GitHub-Api-Version": COPILOT_CAPI_API_VERSION,
    "X-Request-Id": crypto.randomUUID(),
    "x-policy-id": "nil",
    ...headers,
  }
}

export * as CopilotHeaders from "./headers"
