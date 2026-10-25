// 安卓版配置：用 Capacitor 把 src/renderer 的界面装进安卓 App。
// 界面先用 `npm run build:web` 构建到 out/web，再由 `cap sync android` 复制进 android/ 工程。
import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.moyer.mail',
  appName: 'Moyer Mail',
  webDir: 'out/web',
  android: {
    // 邮件里的图片多是 http 链接，允许混合内容，否则会显示不出来
    allowMixedContent: true
  },
  plugins: {
    // 全面屏：界面画到状态栏下面，状态栏/导航栏高度通过 --safe-area-inset-* 变量传给页面
    SystemBars: {
      insetsHandling: 'css',
      initialViewportFitValueHint: 'cover'
    }
  }
}

export default config
