<div align="center">
  <a href="https://github.com/Oleafly/Oleafly">
    <img src="https://raw.githubusercontent.com/Oleafly/Oleafly/69a9c8cb7019312017ad28f6c300be833e416ea5/src-tauri/icons/128x128.png" alt="Oleafly" width="64" height="64" />
  </a>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/connector-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset="./assets/connector-light.svg" />
    <img src="./assets/connector-light.svg" alt="connected to" width="128" height="64" />
  </picture>
  <a href="https://github.com/yetone/magpie">
    <img src="https://usemagpie.ai/img/icon-256.png" alt="Magpie" width="64" height="64" />
  </a>
</div>

<h1 align="center">Magpie Plugin for Oleafly</h1>

<p align="center">
  在 <a href="https://github.com/Oleafly/Oleafly">Oleafly</a> 中直接使用由 <a href="https://github.com/yetone/magpie">Magpie</a> 统一管理的模型、路由组、技能与 MCP 服务器。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-000000?style=flat-square" alt="支持平台：macOS、Linux、Windows" />
  <a href="https://github.com/yetone/magpie/releases/tag/v0.1.4738"><img src="https://img.shields.io/badge/Magpie-0.1.2242%2B-24292F?style=flat-square" alt="Magpie 0.1.2242+" /></a>
  <a href="https://github.com/Oleafly/Oleafly"><img src="https://img.shields.io/badge/Oleafly-0.4.13-34B44A?style=flat-square" alt="Oleafly 0.4.13" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js 22+" />
</p>

<p align="center">
  <a href="./README.md">English</a> · <strong>简体中文</strong>
</p>

---

## 兼容范围

- **支持平台**：macOS、Linux、Windows
- **Oleafly**：`0.4.13`
- **Magpie**：最低 `0.1.2242`，已验证至 [`0.1.4738`](https://github.com/yetone/magpie/releases/tag/v0.1.4738)（截至 2026-11-24 为最新正式版）

> [!NOTE]
> 下限由 MCP Router 决定：更早版本（如 `0.1.2241`）在开启 Router 后，指定为 **Direct** 的 HTTP 服务只会出现在 Hub 中；从 `0.1.2242` 起才会保留独立的直连条目（[上游改动](https://github.com/yetone/magpie/commit/b889ffe813143e4c4b50683db7409f5163b43870)）。

## 快速上手

1. **安装插件**：在 Magpie 的 **Plugins** 页面添加当前仓库目录，或者在仓库根目录的终端（macOS / Linux Shell 或 Windows PowerShell）中运行：

   ```sh
   magpie plugin add "$PWD"
   ```

2. **选择模型**：打开 Magpie 的 **Agents → Oleafly**，选中一个模型或路由组。
3. **重启 Oleafly**：如果改模型时 Oleafly 正开着，先彻底退出再重新打开，然后新建对话。新启动的 Oleafly CLI（`oleafly` / `oleafly-cli`）会自动使用更新后的默认配置。

> [!NOTE]
> 只安装插件不会改动你原本的聊天模型，等你真正在 Magpie 里选定模型后才会生效。后续切换模型时，插件只会在原地更新同一个 Magpie Provider，不会影响你单独给 **Oleafly Tools** 指定的模型。

Oleafly 会通过本地 Magpie 网关已配置的端口和 Oleafly 归因令牌发起请求。如果网关没启动或暂时连不上，Magpie 会给出提示，并在后台持续重试。

## 技能与 MCP 服务器

在 Magpie 的 **Library** 页面把需要的技能或 MCP 服务器分配给 **Oleafly** 即可同步。

### 技能（Skills）

- **整目录复制**：插件会自动把 Oleafly 的技能分发方式设为 **Copy**，将整个技能目录（包括参考文件和附属资源）完整复制到当前生效的 Oleafly 数据目录中。
- **同名冲突**：如果 Oleafly 里已经有同名技能，可以直接在 Magpie 中选择 **Keep own**（保留本地）或 **Use Library**（使用 Library 版本）。
- **项目级开关**：Oleafly 内部针对单个项目的技能启用/禁用设置依然照常生效。

### MCP 服务器

- **开启 MCP Router 时**：Oleafly 会接入属于它的 Magpie Hub，同时保留所有标记为 **Direct** 的直连服务器。
- **关闭 MCP Router 时**：Oleafly 会分别直连已分配的 stdio、Streamable HTTP 和插件工具服务器。
- **工具级权限限制**：Oleafly 无法对直连服务器执行单工具级别的黑白名单规则。如果某个直连服务器带有工具级限制，Magpie 会暂不下发并标出提示；把它改为通过 Hub 路由，就能由 Magpie 统一执行限制。
- **URL 与鉴权**：直连服务器的 URL 会保存在 Oleafly 配置中（支持数字形式的 `version` 查询参数）。如果 URL 的查询参数里带了密钥或凭据，建议把鉴权改到请求头里，或者改走 Magpie 路由。
- **保留本地修改**：如果你在 Oleafly 里手动改过某个托管服务器，之后又在 Library 里取消了分配，插件只会把它禁用而不会直接删掉，方便你留底核对。

> [!TIP]
> 如果在修改分配时 Oleafly 的 **Assistant MCP** 设置面板正开着，关闭面板再重新打开即可看到刷新后的服务器列表。

## 断开连接与清理

- **仅恢复模型**：在 **Agents** 页面把 Oleafly 切回 **default**。聊天模型会恢复成你接入前的设置（如果你在连接期间删掉了原来的自定义 Provider，则会回退到 Oleafly 默认模型），而 Library 里的技能与 MCP 分配仍会保持同步。
- **停用或卸载插件**：在 **Plugins** 页面关闭或移除插件后，插件会恢复原来的聊天模型，并清理掉你没有本地改动过的托管配置。
- **不悄悄覆盖本地改动**：遇到需要你确认的情况，Magpie 会发出提醒并把文件留在原地——比如你修改过的技能副本，或者 **Oleafly Tools** 仍在引用的 Magpie Provider。
- **延迟清理**：如果停用或卸载插件时 Oleafly 刚好正在保存配置，清理流程会等待配置锁释放。
  - **macOS 与 Linux**：等 Oleafly 释放锁后会自动完成清理；如果过程中出现冲突，说明会写入当前 Oleafly 数据目录下的 `.magpie-oleafly-cleanup.txt`。
  - **Windows**：如果锁一直持续到 Magpie 退出之后，请按当前 Oleafly 数据目录下的 `.magpie-oleafly-cleanup.txt` 提示处理——等 Oleafly 保存完毕后，重新启用插件（若已卸载则先重新安装），再将其停用即可完成恢复与清理。

## 工作原理

插件运行在 Magpie 的 Bun 宿主进程中，会在持有 Oleafly 配置锁的前提下更新 `config.json`。Magpie 暂存目录中的 MCP 配置在同步前可能包含明文凭据，并受目录访问权限保护（macOS / Linux 为仅当前用户可访问的 `0700`，Windows 为私有用户 ACL）；同步到 Oleafly 后，模型密钥以及 MCP 请求头和环境变量中的凭据都会存入 Oleafly 自己的加密密钥库。

### 自动发现

即使没有把 CLI 加入 `PATH`，Magpie 也能在 **Agents** 页面自动识别已安装的 Oleafly：

- **macOS**：检测 `/Applications/Oleafly.app`、`~/Applications/Oleafly.app`、`PATH` 中的 CLI 或已有 `config.json`。
- **Linux**：检测 XDG `.desktop` 启动项、`~/Applications` 下可执行的 Oleafly AppImage、`PATH`（或 `~/.local/bin/oleafly`）中的 CLI 或已有 `config.json`。
- **Windows**：检测标准 MSI / 当前用户安装路径（`%ProgramFiles%\Oleafly\oleafly.exe`、`%LOCALAPPDATA%\...`）、注册表中的 `oleafly` 协议处理程序、`PATH` 中的 CLI 或已有 `config.json`。

### 相关文件与目录

| 路径 | 用途 |
| --- | --- |
| `~/.magpie-oleafly/`（Windows：`%USERPROFILE%\.magpie-oleafly\`） | 私有暂存目录，用来存放 Agent 与 Library 的当前选择 |
| `~/.oleafly/`（Windows：`%USERPROFILE%\.oleafly\`） | 默认的 Oleafly 数据目录（可通过 `OLEAFLY_DATA_DIR` 覆盖） |
| `<data-dir>/.magpie-oleafly-state.json` | 托管项指纹与接入前的模型记录，用于检测本地修改与安全回滚 |
| `<data-dir>/.magpie-oleafly-cleanup.txt` | 延迟清理产生冲突时的记录，或 Windows 下的后续恢复指引（无异常时不生成） |

如果你使用了独立的 Oleafly 配置目录，请同时在 Magpie 和 Oleafly 的运行环境中设置相同的 `OLEAFLY_DATA_DIR`。

## 开发与测试

单元测试需要 Node.js 22 或更高版本；在 Windows 上运行前，请先将 `MAGPIE_BUN` 指向 Magpie 使用的 Bun 可执行文件：

```sh
npm test
```

Windows、Linux 与 macOS 的环境配置、端到端集成测试及桌面端验证记录，请参阅 [integration/README.md](integration/README.md)。
