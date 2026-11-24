# Windows, macOS and Linux Integration Tests

The end-to-end suite targets **Oleafly 0.4.13** with **Magpie 0.1.2242 or newer**, verified through [**0.1.4738**](https://github.com/yetone/magpie/releases/tag/v0.1.4738) (latest release as of 24 November 2026), against a disposable profile.

## Running the Suite

Run the checked-in harness with Magpie 0.1.4705 or 0.1.4723 and native Node.js 22+ or Bun 1.4.2. Magpie and the stdio MCP fixture use the executable supplied in `MAGPIE_BUN`.

```sh
MAGPIE_BUN=/absolute/path/to/bun node integration/acceptance.mjs
```

On Linux the suite uses `/usr/bin/flock`. Set `MAGPIE_BIN` to the Magpie executable and `OLEAFLY_BIN` to the native `oleafly-cli` if they are outside `/usr/bin`. The latter may be the binary in an extracted AppImage. A separate discovery check starts with an empty profile, isolated XDG directories and only the launcher's executable on `PATH`. It verifies that an XDG desktop entry registers exactly one Oleafly agent before any model is configured.

The default run installs, disables, re-enables, and removes this plugin through Magpie's resident Plugins handlers, while exercising the Agents and Library handlers against a fresh Oleafly CLI. The script exits nonzero if any check fails.

### Windows PowerShell

Keep `acceptance.mjs` and `fixtures.mjs` together. They can be copied from `integration` to a separate directory when testing an unpacked release. Point `OLEAFLY_PLUGIN_DIR` at the package directory containing `package.json`. Replace the example paths with absolute paths on the test machine.

```powershell
$env:MAGPIE_BIN = 'C:\tools\magpie\magpie.exe'
$env:OLEAFLY_BIN = 'C:\Program Files\Oleafly\oleafly-cli.exe'
$env:MAGPIE_BUN = 'C:\tools\bun\bun.exe'
$env:OLEAFLY_PLUGIN_DIR = 'C:\test\package'
$suite = 'C:\test\integration\acceptance.mjs'

node $suite --preflight
node $suite
```

To use Bun as the harness runner, invoke `& $env:MAGPIE_BUN $suite`. Repeat with the other Magpie version by changing `MAGPIE_BIN`. Use the standalone Magpie executable and the native Oleafly CLI. The harness invokes Magpie by full path and checks that the Windows child `PATH` contains no `magpie` command, so applying Library copy mode exercises the bridge's parent executable lookup.

Preflight reports native skill loading, reference reads and each MCP transport separately. The full run requires the updated Library reference and actual tool results with the Router off and on. A missing tool in the CLI catalog and a missing expected tool result produce different failures. Both runs print the selected versions and exit nonzero on failure.

The Windows discovery check uses the desktop executable beside the supplied CLI. It recreates the MSI layout at `%ProgramFiles%\Oleafly\oleafly.exe` before installing the plugin into a fresh profile with no Oleafly CLI on `PATH`.

Windows unit tests also use the Magpie Bun runtime. Set `MAGPIE_BUN` and run `npm test` from the checkout.

### Options & Environment Variables

| Option / Variable | Description |
| --- | --- |
| `MAGPIE_BUN` | *(Required)* Absolute path to the Bun 1.4.2 binary |
| `MAGPIE_BIN` | Magpie executable, required on Windows. Linux defaults to `/usr/bin/magpie` and macOS to the app bundle |
| `OLEAFLY_BIN` | Oleafly CLI executable, required on Windows. Linux defaults to `/usr/bin/oleafly-cli` and macOS to the app bundle |
| `OLEAFLY_PLUGIN_DIR` | Override the plugin package directory under test |
| `--preflight` | Run the native gateway, model, skill, reference and three MCP controls before installing the Oleafly plugin, then exit |
| `--cli` | Run the full CLI suite using CLI plugin actions |
| `--gui` | Keep the isolated fixture running and generate a private launcher for manual browser testing |

### Isolation

Each run creates a fresh temporary home directory, a separate `OLEAFLY_DATA_DIR`, and a minimal Markdown project. The fixture and Magpie bind to separate loopback ports, use synthetic credentials, disable account discovery, and send background HTTP traffic through a loopback proxy that blocks non-fixture requests. Child output is suppressed except for sanitized verdicts, and the temporary profile is removed on exit.

Windows children receive isolated `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, XDG and temporary directories. Windows PowerShell holds byte zero of `.config-store.lock` with a separate .NET FileStream while Magpie attempts a model change, disable or uninstall. At restart and exit the harness stops the resident process tree by PID before removing the profile.

On Windows, Magpie ends the plugin and its child processes together. The suite releases a short lock during uninstall and holds a longer lock past shutdown during disable. In the latter case Oleafly keeps its current configuration. The plugin writes recovery instructions to `.magpie-oleafly-cleanup.txt` in the Oleafly data directory. Once Oleafly finishes saving, enable the plugin again (reinstall it if removed), then disable it to finish restoring the previous settings.

## Interactive Web UI (`--gui`)

```sh
MAGPIE_BUN=/absolute/path/to/bun node integration/acceptance.mjs --gui
```

This mode verifies Magpie's web Agents picker and Library controls through the installed host, prints the path to a private HTML launcher, and keeps the fixture running:

1. Open the printed HTML file in a private browser window and click **Open isolated Magpie**. The launcher submits the disposable web secret without exposing it in the address bar.
2. The fixture provides **Acceptance fixture** models and the **Acceptance route** group.
3. Library comes preloaded with `stdioprobe`, `remoteprobe`, `fixturekit`, an unassigned `unassignedprobe` server, and a skill with a name collision.
4. The terminal prints the temporary Oleafly data and project paths. Press `Ctrl-C` when finished.

## Covered CLI Checks

- **Install:** Add the plugin through Magpie Plugins and confirm Oleafly is detected without changing its existing model.
- **Models & routing:** Run fresh Oleafly chats after switching between both fixture models and the routing group. Verify Usage attribution, the restart notice, resync, resident restart, and preservation of the existing Tools model.
- **MCP transports:** Run assigned stdio, direct HTTP, and plugin tools with the MCP Router both off and on. Verify the agent-scoped hub URL and retained direct entry, and confirm that calling the exact unassigned tool identifier is rejected.
- **Skills:** Import, assign, update, load, and unassign a skill through Library. Verify reference files, binary assets, per-agent copy mode, and preservation of a same-name user skill.
- **Locks & gateway errors:** Hold Oleafly's transaction lock across a model change and a resident host restart before releasing it. Test an unreachable gateway and recovery through Agents.
- **Restricted direct MCPs:** Add per-tool restrictions to an edited direct MCP entry and confirm a fresh Oleafly CLI no longer exposes its tool while keeping the disabled entry's local edits intact.
- **Reset, disable & uninstall:** Reset the model independently of Library. Hold Oleafly's config lock across disable and uninstall, then confirm the later chat selection is restored and the skill copy, managed MCP entries, and staged credential are cleaned up.

## Compatibility range verification (24 November 2026)

Oleafly `0.4.13` requires **Magpie `0.1.2242` or newer**, verified through [**`0.1.4738`**](https://github.com/yetone/magpie/releases/tag/v0.1.4738) (the latest official release as of 24 November 2026).

### Minimum version boundary (`0.1.2242`)

The floor is set by MCP Router behavior. The previous release (`0.1.2241`) passes model switching, skill reads, and tool calls with the MCP Router off, but with the Router on, HTTP servers marked **Direct** only appear inside the hub. `0.1.2242` is the first release that preserves standalone direct entries ([upstream commit](https://github.com/yetone/magpie/commit/b889ffe813143e4c4b50683db7409f5163b43870)) and passes direct tool execution.

### Endpoint matrix

| Environment | Magpie `0.1.2242` | Magpie `0.1.4738` |
| --- | --- | --- |
| macOS (Apple Silicon) | 19/19 passed | 19/19 passed |
| Rocky Linux 10.3 (ARM64) | 21/21 passed | 21/21 passed |
| Windows 11 (ARM64, non-admin) | 22/22 passed | 22/22 passed |

- **Range sampling:** On Linux, 13 official releases across `0.1.2242`–`0.1.4738` were sampled and all passed.
- **Coverage:** Model and routing-group switching, Usage attribution, actual tool calls in both Router modes, rejection of unassigned tools, skill reference reads, lock conflict recovery, disable, and uninstall.
- **Scope note:** Both endpoints passed Magpie's Agents/Library controls and the native Oleafly CLI. Native desktop window checks below correspond to **macOS/Linux `0.1.4705`** and **Windows `0.1.4723`**.

## Windows verification (24 November 2026)

The packed plugin passed the full suite on Windows 11 Pro ARM64 under a non-administrator account with Magpie 0.1.4705 and 0.1.4723, Bun 1.4.2 ARM64 and the Oleafly 0.4.13 x64 CLI from the official MSI. Each run detected the desktop executable without a CLI on `PATH`, switched models and a routing group, and attributed fresh CLI requests to Oleafly. Both Router modes executed all three assigned MCP transports and rejected the unassigned tool. Oleafly loaded the skill and read its updated reference. Reset, lock recovery, disable and uninstall preserved the expected user settings.

In the Windows desktop app with Magpie 0.1.4723, the first chat reached `fixture-first`. After Magpie switched to `fixture-second`, a new chat in the same window still tried the old model and reported that it was disabled. The upstream fixture received no request from that chat.

After closing and reopening Oleafly, all four requests from a new chat reached `fixture-second` under Oleafly in Magpie Usage. With the MCP Router off, the assistant called the assigned HTTP tool after approval and returned its receipt to the model. It also loaded the assigned skill and returned the unique marker from `references/receipt.md`.

## Linux verification (24 November 2026)

The packed plugin passed the CLI and Web suite on Rocky Linux 10.3 ARM64 with Magpie 0.1.4705, Oleafly 0.4.13 and Bun 1.4.2.

- With the Oleafly CLI outside `PATH`, a registered XDG desktop entry, an executable Oleafly AppImage under `~/Applications`, and a custom profile containing `config.json` each produced one Agents row in a fresh home. An empty home produced zero rows. Detection alone preserved the model.
- A fresh chat in the GNOME AppImage window returned the fixture reply. Magpie Usage recorded the additional call under Oleafly and the selected model. After a model change, the open window tried its previous model. Reopening Oleafly and starting a new chat routed the request to the new selection.
- Both Router modes, skill updates, lock recovery, model reset, disable and uninstall passed through the installed host. Disable and uninstall removed the desktop detection directory.

## macOS verification (23 November 2026)

### CLI & Web Suite

Tested on arm64 macOS against installed **Magpie 0.1.4705**, **Oleafly 0.4.13**, and **Bun 1.4.2**.

- Initial connection, Usage attribution, model and routing-group switches, resident restart, and the Tools model override all passed.
- Assigned tools executed in both MCP Router modes; calling the exact unassigned tool identifier returned Oleafly's unavailable-tool error in both modes.
- Library copied the skill as a real directory into the custom Oleafly data directory with its reference and binary asset intact. Oleafly CLI loaded the skill and read the updated reference, while Magpie backed up the displaced user skill in Library.
- Holding the transaction lock kept the previous config byte-for-byte; restarting the resident host applied the pending update once the lock cleared.
- When the gateway was unavailable, the previous config stayed untouched, and switching back to a working route recovered the CLI.
- Resetting the model kept MCP assignments intact. Disconnecting reported conflicts while preserving a later chat selection, provider, and unrelated MCP edits.
- Both disable and uninstall started from a verified managed skill copy, removed the copy and managed MCP entries, and left the user's later provider usable.
- Installed web endpoints passed model selection, restart notice, default reset, MCP assignment/removal, and withholding restricted direct servers with a diagnostic.
- In a separate browser check, the Agents picker applied the first fixture model and Library added and removed the direct HTTP server. Toggling the plugin off restored the original model; toggling it back on and picking the second fixture model reached Oleafly. Uninstalling the re-enabled plugin restored the original provider and kept the unrelated MCP server.

### Native Oleafly Window

Verified using an isolated copy of the installed **Oleafly 0.4.13** app pointed at a temporary project, data directory, and WebKit store:

- The first desktop chat returned the fixture response, and Magpie recorded a successful request attributed to Oleafly on `fixture-first`. Assistant MCP settings showed the assigned HTTP server connected with one tool.
- While the window stayed open, switching to `fixture-second` and unassigning the HTTP server in Magpie left the open MCP panel showing the old server until the panel was closed and reopened. Starting a new chat in the same running process still sent `fixture-first`, which Oleafly rejected because the updated provider catalog only listed `fixture-second`.
- After quitting and reopening Oleafly, a new desktop chat returned the fixture response and Magpie recorded the request under Oleafly on `fixture-second`.
