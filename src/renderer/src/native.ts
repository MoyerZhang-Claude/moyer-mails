// 安卓（Capacitor）专用：状态栏颜色、返回键。桌面版不会执行这里的代码。
import { nativePlugin } from './api'
import { selectMessage, setSearch, setView, useStore } from './store'

interface CapacitorGlobal {
  isNativePlatform?: () => boolean
  getPlatform?: () => string
}

const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor
export const isNative = !!cap?.isNativePlatform?.()

/** 状态栏文字颜色跟着主题走：浅色主题用深色字 */
export async function setSystemBarsDark(dark: boolean) {
  if (!isNative) return
  const { SystemBars, SystemBarsStyle } = await import('@capacitor/core')
  await SystemBars.setStyle({ style: dark ? SystemBarsStyle.Dark : SystemBarsStyle.Light }).catch(() => undefined)
}

/** 安卓返回键：依次关闭弹窗、写信窗口、侧栏、阅读区，最后才退到后台 */
async function setupBackButton() {
  const { App } = await import('@capacitor/app')
  await App.addListener('backButton', () => {
    const s = useStore.getState()
    if (s.dialog) {
      if (s.dialog.kind === 'confirm') s.dialog.resolve(false)
      useStore.setState({ dialog: null })
    } else if (s.composers.some((c) => !c.minimized)) {
      useStore.setState({ composers: s.composers.map((c) => ({ ...c, minimized: true })) })
    } else if (s.sidebarOpen) {
      useStore.setState({ sidebarOpen: false })
    } else if (s.selectedId != null) {
      void selectMessage(null)
    } else if (s.search) {
      setSearch('')
    } else {
      void App.minimizeApp()
    }
  })
}

/** 界面加载完成后：申请通知权限；如果是从新邮件通知点进来的，打开那封邮件 */
async function onReady() {
  if (!nativePlugin) return
  if (useStore.getState().settings?.notifications !== false) await nativePlugin.requestNotifications().catch(() => undefined)
  const { id } = await nativePlugin.takeLaunchMessage().catch(() => ({ id: null }))
  if (id) {
    setView({ kind: 'unified', box: 'inbox' })
    void selectMessage(id)
  }
}

export async function backgroundUnrestricted(): Promise<boolean> {
  return (await nativePlugin?.backgroundStatus().catch(() => null))?.unrestricted ?? false
}

export function openBatterySettings() {
  void nativePlugin?.openBatterySettings()
}

export async function requestNotificationPermission(): Promise<boolean> {
  return (await nativePlugin?.requestNotifications().catch(() => null))?.granted ?? false
}

export function setupNative() {
  if (!isNative) return
  document.documentElement.classList.add('native', `platform-${cap?.getPlatform?.() ?? 'android'}`)
  void setupBackButton()
  const unsub = useStore.subscribe((s) => {
    if (!s.ready) return
    unsub()
    void onReady()
  })
}
