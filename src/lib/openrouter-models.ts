export const OPENROUTER_MODEL_ISSUE =
  /model.*not.*found|invalid.*model|no longer available|no endpoints found|not available for your API key/i

function compactModels(models: Array<string | undefined | null>): string[] {
  return Array.from(new Set(models.map((m) => (m || '').trim()).filter(Boolean)))
}

export function openRouterVisionModels(preferred?: string | null): string[] {
  return compactModels([
    preferred,
    process.env.OPENROUTER_VISION_MODEL,
    '~openai/gpt-mini-latest',
    'google/gemini-3.1-flash-lite',
    'openai/gpt-4o-mini',
    'google/gemini-2.0-flash-001',
    '~anthropic/claude-haiku-latest',
  ])
}

export function openRouterAgentModels(preferred?: string | null): string[] {
  return compactModels([
    preferred,
    process.env.OPENROUTER_AGENT_MODEL,
    'anthropic/claude-sonnet-4.5',
    'google/gemini-3.5-flash',
    'openai/gpt-chat-latest',
    '~openai/gpt-mini-latest',
  ])
}

export function isOpenRouterModelIssue(status: number, detail: string): boolean {
  return status === 400 || status === 404 || OPENROUTER_MODEL_ISSUE.test(detail)
}
