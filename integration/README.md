# Installed acceptance on macOS

The harness runs the installed Magpie 0.1.4705 and Oleafly 0.4.13 CLIs against a disposable profile. Use Node.js 22 or newer and an absolute path to Bun 1.4.2, Magpie's pinned plugin runtime. The default run installs, disables, re-enables and removes the package through the resident Plugins page handlers. It also exercises the Agents and Library handlers and a fresh Oleafly CLI.

```sh
MAGPIE_BUN=/absolute/path/to/bun node integration/acceptance.mjs
```

The default executable paths point into the installed app bundles in `/Applications`. Set `MAGPIE_BIN`, `OLEAFLY_BIN`, or `OLEAFLY_PLUGIN_DIR` to test another binary or package checkout. The command exits nonzero on a failed check. Add `--preflight` to exercise the fixture, native gateway, original Oleafly model, and three MCP transports before running the package under test.

The harness creates a fresh temporary home, a distinct `OLEAFLY_DATA_DIR`, and a small Markdown project. It binds the fixture and Magpie to separate loopback ports, uses synthetic credentials, disables account discovery, and directs background HTTP requests to a loopback proxy that refuses non-fixture requests. It discards child output except for sanitized verdicts and removes the profile when it exits.

## Magpie web fixture

```sh
MAGPIE_BUN=/absolute/path/to/bun node integration/acceptance.mjs --gui
```

The harness checks Magpie's web Agents picker and Library controls through the installed host, then prints the path to a private launcher and keeps the fixture running. Open that HTML file in a private browser window and click **Open isolated Magpie**. The launcher submits the disposable web secret without putting it in the address bar. The fixture offers **Acceptance fixture** models and the **Acceptance route** group. Library contains `stdioprobe`, `remoteprobe`, `fixturekit`, an unassigned `unassignedprobe` server, and a skill with a same-name collision. The terminal also shows the Oleafly data and project paths. Press Ctrl-C in the harness terminal when finished.

## CLI assertions

- Install through Magpie Plugins and verify one detected agent with the original Oleafly model still selected.
- Run fresh Oleafly chats after selecting both models and the routing group. Verify Usage attribution, the restart notice, resync, resident restart, and the existing Tools model.
- Execute assigned stdio, direct HTTP, and plugin tools with Router off and on. Verify the agent-scoped hub URL and the retained direct entry. Ask Oleafly to call the exact unassigned tool identifier and require a rejection.
- Import, assign, update, load, and unassign a skill through Library. Verify its reference and binary asset, per-agent copy mode, and same-name user skill preservation.
- Block a model change with Oleafly's transaction lock and restart the resident host before releasing it. Exercise an unavailable gateway and retry through Agents.
- Reset the model separately from Library. Preserve and report later edits. Reassign the managed skill before each disable and uninstall check and verify removal of the live copy.

## Observations on 23 November 2026

Tested the installed arm64 Magpie 0.1.4705 and Oleafly 0.4.13 binaries with Bun 1.4.2. First connection, Usage attribution, model and routing-group changes, resident restart, and the Tools override passed. Both Router modes ran the assigned tools. An attempt to call the exact unassigned identifier returned Oleafly's unavailable-tool error in both modes.

Library copied the skill into the custom Oleafly data directory as a real directory with its reference and binary asset. The CLI loaded the skill and read the updated reference. Magpie preserved the displaced user skill in its Library backup. The transaction-lock interruption kept the previous configuration byte-for-byte. The resident restart applied the pending change after lock release. An unavailable gateway preserved the previous config, and selecting the working route recovered the CLI. Reset retained MCP assignments, and disconnect reported the conflict while preserving a later chat selection, provider, and unrelated MCP edit.

Disable and uninstall each started with a verified managed skill copy. Both removed that copy and the managed MCP entries and left the later user provider usable. **Re-enable through the resident Plugins controls passed.** The separate cross-process CLI check (`--cli`) was intermittent on re-enable. On a failed run, Agents wrote the correct model, gateway, and identity, and refreshing the model catalog left the selection pending. A real call to the fixture plugin tool on the same resident gateway applied it. A separate failed run recovered after restarting the resident process. The harness records re-enable as failed even when recovery allows the uninstall check to proceed.

The installed web endpoints passed model selection, restart notice, default reset, MCP assignment and removal, and direct-server restriction withholding with a diagnostic. In a separate browser run, the Agents picker applied the first fixture model, and the Library control assigned and removed the direct HTTP server. Switching the plugin off in Plugins restored the original selection. Switching it back on and choosing the second fixture model reached Oleafly. Removing the re-enabled plugin through Plugins restored the original provider and preserved the unrelated MCP server.


## Native Oleafly window

A separately identified copy of the installed Oleafly 0.4.13 app opened a temporary project with its own data directory and WebKit storage. Its first desktop chat returned the fixture answer. Magpie recorded a successful request attributed to Oleafly on `fixture-first`. Assistant MCP settings listed the assigned HTTP server as connected with one tool.

With the window open, the model changed to `fixture-second` and the HTTP assignment was removed in Magpie. The open MCP panel continued to list the server until the panel was closed and reopened. Starting a new chat in the same process still selected `fixture-first`, which Oleafly rejected because the updated provider catalog contained the second model. After quitting and reopening Oleafly, a fresh desktop chat returned the fixture answer and Magpie recorded a successful Oleafly request on `fixture-second`.
