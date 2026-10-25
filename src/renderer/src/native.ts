// 安卓（Capacitor）专用：状态栏颜色、返回键。桌面版不会执行这里的代码。
import { selectMessage, setSearch, useStore } from './store'

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

export function setupNative() {
  if (!isNative) return
  document.documentElement.classList.add('native', `platform-${cap?.getPlatform?.() ?? 'android'}`)
  void setupBackButton()
}
