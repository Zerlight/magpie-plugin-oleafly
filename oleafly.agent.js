// Magpie runs this module in moejs, which loads JavaScript modules.
export const agent = {
  "id": "oleafly",
  "name": "Oleafly",
  "bin": "oleafly",
  "dir": "/Applications/Oleafly.app",
  "config": "~/.magpie-oleafly/agent.json",
  "model": "model",
  "notice": "If Oleafly is open, quit and reopen it before starting a new conversation.",
  "library": {
    "skills": "~/.magpie-oleafly/skills",
    "mcp": "~/.magpie-oleafly/mcp.json",
    "mcpFormat": "claude"
  }
}

export function connect({ gateway, model, agent: target }) {
  if (
    target?.id !== agent.id ||
    typeof model?.id !== "string" || !model.id
  ) {
    throw new Error("Select a Magpie model and check that the gateway is configured for Oleafly.")
  }
  // Magpie records the key in its recovery stash. The loopback token is a public agent label.
  if (
    typeof gateway?.v1 !== "string" ||
    !/^https?:\/\/(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?\/v1$/i.test(gateway.v1) ||
    gateway.key !== "magpie-" + target.id
  ) {
    throw new Error("Use a loopback Magpie gateway to connect Oleafly.")
  }
  return { baseURL: gateway.v1, gatewayKey: gateway.key, agentId: target.id }
}
