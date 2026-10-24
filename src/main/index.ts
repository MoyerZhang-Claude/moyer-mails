import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, safeStorage, session, shell, Tray } from 'electron'
import { statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { API_METHODS } from '@shared/api'
import { findPalette } from '@shared/theme'
import type { Counts, EngineEventName, Settings } from '@shared/types'
import { Engine } from '../core/engine'
import type { Host } from '../core/host'
import { friendlyError, UserError } from '../core/util'

app.setAppUserModelId('com.moyer.mail')
app.setName('Moyer Mail')
// 便携模式 / 测试：用环境变量指定数据目录
if (process.env.MOYER_DATA_DIR) app.setPath('userData', process.env.MOYER_DATA_DIR)

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

const startHidden = process.argv.includes('--hidden')
const resources = join(app.getAppPath(), 'resources')
const iconPath = join(resources, 'icon.png')

let win: BrowserWindow | null = null
let tray: Tray | null = null
let engine: Engine
let quitting = false
let closeToTray = true
let lastUnread = 0

function isDark(s: Settings) {
  return s.theme === 'dark' || (s.theme === 'system' && nativeTheme.shouldUseDarkColors)
}

function showWindow() {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function emit(name: EngineEventName, payload: unknown) {
  if (name === 'counts') updateUnread((payload as Counts).unified.inbox)
  if (win && !win.isDestroyed()) win.webContents.send('engine-event', name, payload)
}

function updateUnread(n: number) {
  lastUnread = n
  const title = n > 0 ? `Moyer Mail（${n} 封未读）` : 'Moyer Mail'
  tray?.setToolTip(title)
  win?.setTitle(title)
}

function createHost(): Host {
  const net = session.fromPartition('persist:moyer-net')
  return {
    dataDir: app.getPath('userData'),
    appVersion: app.getVersion(),
    encrypt(plain) {
      if (safeStorage.isEncryptionAvailable()) return safeStorage.encryptString(plain).toString('base64')
      return 'plain:' + Buffer.from(plain, 'utf8').toString('base64')
    },
    decrypt(cipher) {
      if (cipher.startsWith('plain:')) return Buffer.from(cipher.slice(6), 'base64').toString('utf8')
      return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
    },
    fetch: (url, init) => net.fetch(url, init as RequestInit),
    resolveSystemProxy: (url) => session.defaultSession.resolveProxy(url),
    openExternal: (url) => shell.openExternal(url),
    async openPath(p) {
      const err = await shell.openPath(p)
      if (err) throw new UserError(`无法打开文件：${err}`)
    },
    async saveDialog(name) {
      const opts = { defaultPath: join(app.getPath('downloads'), name) }
      const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      return r.canceled || !r.filePath ? null : r.filePath
    },
    async pickFiles() {
      const opts = { properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[] }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      return r.filePaths.map((p) => ({ path: p, filename: basename(p), size: statSync(p).size }))
    },
    notify(title, body, onClick) {
      if (!Notification.isSupported()) return
      const n = new Notification({ title, body, icon: iconPath })
      n.on('click', () => {
        showWindow()
        onClick()
      })
      n.show()
    },
    emit,
    applySettings(s) {
      closeToTray = s.closeToTray
      if (s.proxy.mode === 'off') void net.setProxy({ mode: 'direct' })
      else if (s.proxy.mode === 'system') void net.setProxy({ mode: 'system' })
      else if (s.proxy.url.trim()) void net.setProxy({ mode: 'fixed_servers', proxyRules: s.proxy.url.trim().replace(/^socks5h:/, 'socks5:') })
      if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: s.launchAtLogin, args: ['--hidden'] })
    },
    log: (...args) => console.log('[engine]', ...args)
  }
}

function createWindow() {
  const s = engine.settings.get()
  const dark = isDark(s)
  const pal = findPalette(s.palette)
  const saved = engine.db.getKv('window')
  const bounds = saved ? (JSON.parse(saved) as { x?: number; y?: number; width: number; height: number; maximized?: boolean }) : null

  win = new BrowserWindow({
    width: bounds?.width ?? 1320,
    height: bounds?.height ?? 840,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 380,
    minHeight: 520,
    show: false,
    title: 'Moyer Mail',
    icon: iconPath,
    backgroundColor: (dark ? pal.dark : pal.light).bg,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: dark ? '#e6e6e6' : '#2b2b2b', height: 44 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })
  if (bounds?.maximized) win.maximize()

  win.once('ready-to-show', () => {
    if (!startHidden) win?.show()
    updateUnread(lastUnread)
  })

  win.on('close', (e) => {
    if (!win) return
    const b = win.getNormalBounds()
    engine.db.setKv('window', JSON.stringify({ ...b, maximized: win.isMaximized() }))
    if (!quitting && closeToTray) {
      e.preventDefault()
      win.hide()
    }
  })
  win.on('closed', () => {
    win = null
  })

  // 所有外部链接用系统浏览器打开，应用内不跳转
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) {
      e.preventDefault()
      if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url)
    }
  })
  win.webContents.on('will-frame-navigate', (e) => {
    if (e.isMainFrame) return
    if (/^(https?|mailto):/i.test(e.url)) {
      e.preventDefault()
      void shell.openExternal(e.url)
    }
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))

  if (process.env.MOYER_SCREENSHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        // 开发调试：截图前在页面里执行一段脚本（例如点开某封邮件）
        if (process.env.MOYER_SCREENSHOT_JS) {
          await win!.webContents.executeJavaScript(process.env.MOYER_SCREENSHOT_JS).catch((e) => console.error(e))
        }
        const img = await win!.webContents.capturePage()
        writeFileSync(process.env.MOYER_SCREENSHOT!, img.toPNG())
        console.log('screenshot saved')
        if (process.env.MOYER_SCREENSHOT_EXIT) {
          quitting = true
          app.quit()
        }
      }, Number(process.env.MOYER_SCREENSHOT_DELAY ?? 2500))
    })
  }
}

function createTray() {
  const img = nativeImage.createFromPath(join(resources, 'tray.png'))
  tray = new Tray(img.isEmpty() ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }) : img)
  tray.setToolTip('Moyer Mail')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 Moyer Mail', click: showWindow },
      {
        label: '写邮件',
        click: () => {
          showWindow()
          emit('compose', {})
        }
      },
      { label: '立即同步', click: () => void engine.syncNow() },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('click', showWindow)
}

const allowed = new Set<string>(API_METHODS)

const mainOnly: Record<string, (...args: any[]) => Promise<unknown>> = {
  async setWindowTheme(dark: boolean, color: string) {
    if (!win) return
    win.setBackgroundColor(color)
    win.setTitleBarOverlay({ color: '#00000000', symbolColor: dark ? '#e6e6e6' : '#2b2b2b', height: 44 })
  },
  async appInfo() {
    return { version: app.getVersion(), dataDir: app.getPath('userData'), platform: process.platform }
  }
}

ipcMain.handle('api', async (_e, method: string, args: unknown[]) => {
  try {
    if (!allowed.has(method)) throw new UserError(`未知操作：${method}`)
    const fn = mainOnly[method] ?? (engine as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method]
    const result = await fn.apply(mainOnly[method] ? mainOnly : engine, args ?? [])
    return { ok: true, result }
  } catch (err) {
    if (!(err instanceof UserError)) console.error(`[api] ${method}`, err)
    return { ok: false, error: err instanceof UserError ? err.message : friendlyError(err) }
  }
})

app.on('second-instance', showWindow)

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  engine = new Engine(createHost())
  createWindow()
  createTray()
  engine.start()
  nativeTheme.on('updated', () => emit('settings-changed', engine.settings.get()))
})

app.on('before-quit', () => {
  quitting = true
})

app.on('will-quit', (e) => {
  if (!engine) return
  e.preventDefault()
  engine
    .shutdown()
    .catch(() => undefined)
    .finally(() => app.exit(0))
  setTimeout(() => app.exit(0), 3000)
})

app.on('window-all-closed', () => {
  // 托盘常驻，不退出
})
