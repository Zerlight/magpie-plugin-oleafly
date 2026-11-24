// Magpie runs this module in moejs, which loads JavaScript modules.
export const agent = {
  "id": "oleafly",
  "name": "Oleafly",
  "icon": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI1NiIgaGVpZ2h0PSIyNTYiPgogIDxwYXRoIGQ9Ik0yMSAyQzYgMiA0IDE2IDMgMjJoMS45OThjLjY2Ni0zLjMzMyAyLjMzMy01LjE2NiA1LjAwMi01LjUgNC0uNSA3LTQgOC03bC0xLjUtMSAxLTFjMS0xIDIuMDA0LTIuNSAzLjUtNS41eiIgZmlsbD0iIzM0QjQ0QSIvPgo8L3N2Zz4K",
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
