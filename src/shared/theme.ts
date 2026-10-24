// 纯色背景配色。每套配色有浅色和深色两个版本。

export interface PaletteTone {
  bg: string
  accent: string
  orbA: string
  orbB: string
}

export interface Palette {
  id: string
  name: string
  light: PaletteTone
  dark: PaletteTone
}

export const PALETTES: Palette[] = [
  {
    id: 'mist',
    name: '雾蓝',
    light: { bg: '#dde6f0', accent: '#2f6fed', orbA: '#9cc0ff', orbB: '#c7b8ff' },
    dark: { bg: '#121a24', accent: '#5b93ff', orbA: '#1f4f9a', orbB: '#3d2f7a' }
  },
  {
    id: 'mint',
    name: '薄荷',
    light: { bg: '#dbebe4', accent: '#0f9d6e', orbA: '#9be3c6', orbB: '#bfe6ff' },
    dark: { bg: '#101b17', accent: '#2fc48f', orbA: '#14634a', orbB: '#1b4f6b' }
  },
  {
    id: 'apricot',
    name: '暖杏',
    light: { bg: '#f1e5da', accent: '#e06a1b', orbA: '#ffc69a', orbB: '#ffd9e1' },
    dark: { bg: '#1d1611', accent: '#ff8a3d', orbA: '#7a3d15', orbB: '#6b2d3c' }
  },
  {
    id: 'sakura',
    name: '樱粉',
    light: { bg: '#f2e0e6', accent: '#d63d7a', orbA: '#ffb3cf', orbB: '#d9c2ff' },
    dark: { bg: '#1d1217', accent: '#ff5c9a', orbA: '#7a1f45', orbB: '#4a2a7a' }
  },
  {
    id: 'lavender',
    name: '薰衣草',
    light: { bg: '#e5e1f2', accent: '#7048e8', orbA: '#c9b6ff', orbB: '#a8d8ff' },
    dark: { bg: '#15121f', accent: '#9775fa', orbA: '#45288f', orbB: '#1d4a7a' }
  },
  {
    id: 'graphite',
    name: '石墨',
    light: { bg: '#e3e5e8', accent: '#3b5bdb', orbA: '#c3cad6', orbB: '#d6d0c4' },
    dark: { bg: '#131416', accent: '#748ffc', orbA: '#2b3240', orbB: '#3a342b' }
  },
  {
    id: 'paper',
    name: '纸白',
    light: { bg: '#f4f4f2', accent: '#1f1f1f', orbA: '#e3e3dd', orbB: '#ecebe4' },
    dark: { bg: '#0e0e0f', accent: '#e9e9e9', orbA: '#1f1f22', orbB: '#262626' }
  }
]

export function findPalette(id: string): Palette {
  return PALETTES.find((p) => p.id === id) ?? PALETTES[0]
}
