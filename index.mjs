import { startBridge } from './bridge.cjs'

const instance = Symbol.for('magpie-plugin-oleafly.bridge')

export default async function Oleafly({ directory, client }) {
  if (process.platform !== 'darwin' || process.env.MAGPIE_OLEAFLY_SYNCING_SKILLS || globalThis[instance]) return {}
  const report = (message, variant = 'warning') => {
    client.tui.showToast({ body: { title: 'Oleafly', message, variant } })
    client.app.log({ body: { service: 'Oleafly', level: variant === 'info' ? 'info' : 'warn', message } })
  }
  globalThis[instance] = startBridge(directory, report)
  return {}
}
