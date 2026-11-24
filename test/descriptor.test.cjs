const assert = require("node:assert/strict")
const { execFileSync } = require("node:child_process")
const { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } = require("node:fs")
const { tmpdir } = require("node:os")
const { dirname, join } = require("node:path")
const { test } = require("node:test")
const { removeSkillCopies } = require("../skills.cjs")
const entryPath = join(__dirname, "../oleafly.agent.js")
const entry = import("data:text/javascript;base64," + readFileSync(entryPath).toString("base64"))

test("the plugin and agent embed the bundled Oleafly logo", async () => {
  const svg = readFileSync(join(__dirname, "../assets/oleafly/leaf.svg"))
  const icon = "data:image/svg+xml;base64," + svg.toString("base64")
  assert.equal(require("../package.json").magpie.icon, icon)
  assert.equal((await entry).agent.icon, icon)
})

test("connect stages the gateway and agent identity beside Magpie's selected model", async () => {
  const { connect } = await entry
  const request = {
    gateway: { v1: "http://127.0.0.1:4765/v1", key: "magpie-oleafly" },
    model: { id: "group/research" },
    agent: { id: "oleafly" },
  }
  assert.deepEqual(connect(request), {
    baseURL: request.gateway.v1,
    gatewayKey: request.gateway.key,
    agentId: request.agent.id,
  })
  assert.throws(() => connect({ ...request, gateway: { ...request.gateway, key: "fixture-secret" } }), /loopback/)
  assert.throws(() => connect({
    ...request, gateway: { ...request.gateway, v1: "https://gateway.example.test/v1" },
  }), /loopback/)
  assert.throws(() => connect({ ...request, agent: { id: "other" } }), /configured for Oleafly/)
})

const magpieBin = process.env.MAGPIE_DESCRIPTOR_TEST_BIN

test("Magpie stages model selection and copies assigned skills in an isolated profile", {
  skip: !magpieBin && "Set MAGPIE_DESCRIPTOR_TEST_BIN to a reference Magpie executable.",
}, (t) => {
  const home = mkdtempSync(join(tmpdir(), "magpie-oleafly-descriptor-"))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const config = join(home, "config", "magpie")
  const oleafly = join(home, "active-oleafly")
  const skillsDir = join(oleafly, "skills")
  const library = join(config, "library.json")
  const librarySkillsDir = join(config, "library", "skills")
  const pkg = join(home, "plugin")
  const desired = join(home, ".magpie-oleafly", "agent.json")
  const previousConfig = '{"ai":{"model":"local"}}\n'
  const write = (path, data) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, data)
  }
  const run = (...args) => execFileSync(magpieBin, args, {
    cwd: home,
    encoding: "utf8",
    timeout: 15000,
    env: {
      HOME: home, USERPROFILE: home,
      ...(process.platform === "win32" ? {
        PATH: join(process.env.SystemRoot, "System32"), SystemRoot: process.env.SystemRoot,
        APPDATA: join(home, "roaming"), LOCALAPPDATA: join(home, "local"), TEMP: home, TMP: home,
      } : { PATH: "/usr/bin:/bin" }),
      XDG_CONFIG_HOME: dirname(config),
      XDG_CACHE_HOME: join(home, "cache"),
      XDG_STATE_HOME: join(home, "state"),
      ...(process.env.MAGPIE_BUN && { MAGPIE_BUN: process.env.MAGPIE_BUN }),
      MAGPIE_ADDR: "127.0.0.1:4765",
      MAGPIE_TEST_SANDBOX: "1",
      NO_COLOR: "1",
      OLEAFLY_DATA_DIR: oleafly,
    },
  })
  assert.match(run("version"), /\b0\.1\.(?:4705|4723)\b/)

  write(join(pkg, "package.json"), JSON.stringify({
    name: "magpie-plugin-oleafly",
    magpie: { agent: "./oleafly.agent.js" },
  }))
  copyFileSync(entryPath, join(pkg, "oleafly.agent.js"))
  write(join(oleafly, "config.json"), previousConfig)
  mkdirSync(join(dirname(desired), "desktop"), { recursive: true })
  run("plugin", "add", pkg)
  assert.match(run("ls"), /\bOleafly\b/)
  assert.equal(readFileSync(join(oleafly, "config.json"), "utf8"), previousConfig)
  assert.equal(existsSync(desired), false)

  mkdirSync(skillsDir)
  symlinkSync(skillsDir, join(dirname(desired), "skills"), process.platform === "win32" ? "junction" : "dir")
  run("provider", "add", "Fixture", "id=fixture", "url=http://127.0.0.1:1/v1", "key=fixture-key", "models=first,second")
  run("group", "add", "Research", "models=fixture/first,fixture/second")
  run("oleafly", "fixture/first")
  const selected = JSON.parse(readFileSync(desired, "utf8"))
  assert.equal(selected.model, "fixture/first")
  assert.equal(selected.baseURL, "http://127.0.0.1:4765/v1")
  assert.equal(selected.agentId, "oleafly")
  assert.ok(selected.gatewayKey.endsWith("-oleafly"))
  run("oleafly", "group/research")
  const switched = JSON.parse(readFileSync(desired, "utf8"))
  assert.equal(switched.model, "group/research")
  assert.ok(switched.gatewayKey === selected.gatewayKey)
  run("oleafly", "default")
  assert.deepEqual(JSON.parse(readFileSync(desired, "utf8")), {})
  assert.equal(readFileSync(join(oleafly, "config.json"), "utf8"), previousConfig)

  const source = join(config, "library", "skills", "paper-notes")
  const assigned = join(oleafly, "skills", "paper-notes")
  const collision = join(oleafly, "skills", "review")
  write(join(source, "SKILL.md"), "---\nname: paper-notes\ndescription: Organize paper notes.\n---\n")
  write(join(source, "references", "format.md"), "First version.\n")
  write(join(config, "library", "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Assigned review notes.\n---\n")
  write(join(collision, "SKILL.md"), "---\nname: review\ndescription: Local review notes.\n---\n")
  write(join(collision, ".oleafly-first-party"), "oleafly-first-party-v1\n")
  write(library, JSON.stringify({
    skillRouter: true,
    skills: [
      { name: "paper-notes", agents: ["oleafly"] },
      { name: "review", agents: ["oleafly"] },
    ],
  }))

  assert.match(run("library", "skill", "how", "copy", "oleafly"), /already has a skill of its own called review/)
  const saved = JSON.parse(readFileSync(library, "utf8"))
  assert.deepEqual(saved.skillHow, { oleafly: "copy" })
  assert.ok(!saved.copySkills)
  assert.equal(saved.skillRouter, true)
  assert.ok(lstatSync(assigned).isDirectory())
  assert.equal(readFileSync(join(assigned, "references", "format.md"), "utf8"), "First version.\n")

  write(join(source, "references", "format.md"), "Second version.\n")
  run("library", "sync")
  assert.equal(readFileSync(join(assigned, "references", "format.md"), "utf8"), "Second version.\n")

  run("library", "skill", "agents", "paper-notes", "none")
  assert.equal(existsSync(assigned), false)
  assert.match(readFileSync(join(collision, "SKILL.md"), "utf8"), /Local review notes/)

  run("library", "skill", "agents", "paper-notes", "oleafly")
  assert.deepEqual(removeSkillCopies({ skillsDir, librarySkillsDir, library: JSON.parse(readFileSync(library, "utf8")) }), {
    removed: ["paper-notes"], issues: [],
  })
  assert.equal(existsSync(assigned), false)
  assert.match(readFileSync(join(collision, "SKILL.md"), "utf8"), /Local review notes/)
})
