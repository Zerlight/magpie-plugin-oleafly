# Magpie Plugin for Oleafly

Use Magpie’s models, routing groups, skills, and MCP servers in Oleafly. The integration targets macOS, Magpie 0.1.4705, and Oleafly 0.4.13.

## Connect

1. Add this package folder on Magpie’s **Plugins** page, or run `magpie plugin add "$PWD"` from this checkout.
2. Open **Agents → Oleafly** and pick a model or routing group.
3. If Oleafly was open when you changed the model, quit and reopen it. Start a new conversation. A fresh `oleafly agent run` picks up the same default.

Installation preserves the current chat selection. Choosing a different model updates the same provider and preserves an explicit **Oleafly Tools** model. The connection uses the local Magpie gateway’s configured port and Oleafly attribution token. If the gateway is unavailable, Magpie reports the problem and the bridge retries.

## Manage skills and tools

Assign items to **Oleafly** on Magpie’s **Library** page. The plugin sets skill delivery to **Copy** for Oleafly. Library copies the complete skill folder, including its references and assets, into the active Oleafly data directory. Resolve a name collision with **Keep own** or **Use Library** in Magpie. Project-level skill enablement in Oleafly still applies.

With the MCP Router on, Oleafly receives its agent-scoped hub and any servers marked **Direct**. With the Router off, Oleafly receives the assigned stdio, Streamable HTTP, and plugin tool servers individually. If a direct entry has per-tool restrictions Oleafly cannot enforce, Magpie identifies the withheld server. Routing that server through the hub enforces the restrictions in Magpie. If the Assistant MCP settings panel was open during an assignment change, close and reopen the panel to refresh the server list.

## Disconnect and recover

Select **default** for Oleafly on the Agents page to restore the previous chat selection. Library assignments remain active. Switching the plugin off or removing it from **Plugins** restores the chat selection and removes unchanged managed entries. Magpie reports name collisions and later edits that need attention. An edited skill copy or a provider still used by Oleafly Tools can be kept for that reason.

The agent descriptor and Library writer stage their selections in the private `~/.magpie-oleafly/` directory. The companion runs in Magpie’s Bun host. It updates `config.json` under Oleafly’s configuration lock, stores credential values in Oleafly’s encrypted stores, and keeps recovery fingerprints in `.magpie-oleafly-state.json` in the active data directory. The default directory is `~/.oleafly`. Set `OLEAFLY_DATA_DIR` in both applications’ environments when using a separate profile.

On the reference Magpie release, re-enabling the plugin from a separate CLI process can leave the resident plugin host idle with a model selection pending. Reopen Magpie to apply the selection. The installed **Plugins** page also activates the companion when switching the plugin on.

## Development

Run `npm test` for fixture tests. The installed acceptance harness uses temporary profiles, a local model fixture, and harmless tools. See the [macOS integration checks](integration/README.md).
