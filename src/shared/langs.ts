// 翻译用的语言列表与本地语言识别（不联网，够判断“要不要翻译”即可）。

export interface LangInfo {
  code: string
  name: string
  /** 各翻译服务的语言代码 */
  ms: string
  google: string
  deepl: string | null
  /** 给大模型的语言名 */
  en: string
}

export const LANGS: LangInfo[] = [
  { code: 'zh', name: '简体中文', ms: 'zh-Hans', google: 'zh-CN', deepl: 'ZH-HANS', en: 'Simplified Chinese' },
  { code: 'zh-TW', name: '繁體中文', ms: 'zh-Hant', google: 'zh-TW', deepl: 'ZH-HANT', en: 'Traditional Chinese' },
  { code: 'en', name: '英语', ms: 'en', google: 'en', deepl: 'EN-US', en: 'English' },
  { code: 'ja', name: '日语', ms: 'ja', google: 'ja', deepl: 'JA', en: 'Japanese' },
  { code: 'ko', name: '韩语', ms: 'ko', google: 'ko', deepl: 'KO', en: 'Korean' },
  { code: 'fr', name: '法语', ms: 'fr', google: 'fr', deepl: 'FR', en: 'French' },
  { code: 'de', name: '德语', ms: 'de', google: 'de', deepl: 'DE', en: 'German' },
  { code: 'es', name: '西班牙语', ms: 'es', google: 'es', deepl: 'ES', en: 'Spanish' },
  { code: 'pt', name: '葡萄牙语', ms: 'pt', google: 'pt', deepl: 'PT-BR', en: 'Portuguese' },
  { code: 'it', name: '意大利语', ms: 'it', google: 'it', deepl: 'IT', en: 'Italian' },
  { code: 'ru', name: '俄语', ms: 'ru', google: 'ru', deepl: 'RU', en: 'Russian' },
  { code: 'ar', name: '阿拉伯语', ms: 'ar', google: 'ar', deepl: 'AR', en: 'Arabic' },
  { code: 'th', name: '泰语', ms: 'th', google: 'th', deepl: null, en: 'Thai' },
  { code: 'vi', name: '越南语', ms: 'vi', google: 'vi', deepl: null, en: 'Vietnamese' },
  { code: 'id', name: '印尼语', ms: 'id', google: 'id', deepl: 'ID', en: 'Indonesian' },
  { code: 'tr', name: '土耳其语', ms: 'tr', google: 'tr', deepl: 'TR', en: 'Turkish' },
  { code: 'nl', name: '荷兰语', ms: 'nl', google: 'nl', deepl: 'NL', en: 'Dutch' },
  { code: 'pl', name: '波兰语', ms: 'pl', google: 'pl', deepl: 'PL', en: 'Polish' },
  { code: 'uk', name: '乌克兰语', ms: 'uk', google: 'uk', deepl: 'UK', en: 'Ukrainian' },
  { code: 'hi', name: '印地语', ms: 'hi', google: 'hi', deepl: null, en: 'Hindi' }
]

export function langInfo(code: string | null | undefined): LangInfo | undefined {
  if (!code) return undefined
  const c = code.toLowerCase()
  return (
    LANGS.find((l) => l.code.toLowerCase() === c) ??
    LANGS.find((l) => l.ms.toLowerCase() === c || l.google.toLowerCase() === c || l.deepl?.toLowerCase() === c) ??
    LANGS.find((l) => c.startsWith(l.code + '-') || c.split('-')[0] === l.code)
  )
}

/** 把各服务返回的语言代码统一成本软件的代码 */
export function normalizeLang(code: string | null | undefined): string | null {
  if (!code) return null
  const c = code.toLowerCase()
  if (c === 'zh-hant' || c === 'zh-tw' || c === 'zh-hk') return 'zh-TW'
  if (c.startsWith('zh')) return 'zh'
  return langInfo(c)?.code ?? c.split('-')[0]
}

export function langName(code: string | null | undefined): string {
  if (!code) return '未知语言'
  return langInfo(code)?.name ?? code
}

const STOP: Record<string, string[]> = {
  en: ['the', 'and', 'you', 'your', 'for', 'with', 'this', 'that', 'are', 'have', 'will', 'from', 'please', 'our', 'is', 'to', 'of'],
  fr: ['le', 'la', 'les', 'des', 'vous', 'est', 'pour', 'avec', 'une', 'dans', 'nous', 'votre', 'et', 'que'],
  de: ['der', 'die', 'das', 'und', 'sie', 'ist', 'mit', 'für', 'nicht', 'ein', 'eine', 'ihre', 'wir', 'zu'],
  es: ['el', 'la', 'los', 'las', 'que', 'por', 'para', 'con', 'una', 'usted', 'su', 'es', 'del', 'y'],
  pt: ['o', 'os', 'as', 'que', 'para', 'com', 'uma', 'você', 'não', 'seu', 'sua', 'do', 'da', 'é'],
  it: ['il', 'la', 'che', 'per', 'con', 'una', 'non', 'sono', 'del', 'della', 'gli', 'è', 'di'],
  nl: ['de', 'het', 'een', 'en', 'van', 'je', 'u', 'uw', 'met', 'voor', 'niet', 'is', 'zijn'],
  id: ['dan', 'yang', 'untuk', 'dengan', 'anda', 'ini', 'itu', 'dari', 'kami', 'tidak', 'akan'],
  tr: ['ve', 'bir', 'bu', 'için', 'ile', 'de', 'da', 'çok', 'olarak', 'sizin'],
  pl: ['i', 'w', 'na', 'nie', 'się', 'jest', 'że', 'do', 'z', 'dla', 'oraz'],
  vi: ['và', 'của', 'là', 'các', 'cho', 'với', 'không', 'được', 'bạn', 'này']
}

/** 粗略识别一段文字的语言。只看前 3000 个字符。 */
export function detectLang(input: string): string | null {
  const text = input.slice(0, 3000)
  let han = 0, kana = 0, hangul = 0, cyr = 0, arabic = 0, thai = 0, latin = 0, deva = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c >= 0x4e00 && c <= 0x9fff) han++
    else if (c >= 0x3040 && c <= 0x30ff) kana++
    else if (c >= 0xac00 && c <= 0xd7af) hangul++
    else if (c >= 0x0400 && c <= 0x04ff) cyr++
    else if (c >= 0x0600 && c <= 0x06ff) arabic++
    else if (c >= 0x0e00 && c <= 0x0e7f) thai++
    else if (c >= 0x0900 && c <= 0x097f) deva++
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0xc0 && c <= 0x24f)) latin++
  }
  const total = han + kana + hangul + cyr + arabic + thai + latin + deva
  if (total < 4) return null
  if (kana > 5 && kana + han > total * 0.3) return 'ja'
  if (hangul > total * 0.2) return 'ko'
  if (han > total * 0.15 || (han > 20 && han * 3 > latin)) return 'zh'
  if (cyr > total * 0.3) return /[іїєґ]/i.test(text) ? 'uk' : 'ru'
  if (arabic > total * 0.3) return 'ar'
  if (thai > total * 0.3) return 'th'
  if (deva > total * 0.3) return 'hi'
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? []
  if (words.length === 0) return null
  let best = 'en', bestScore = 0
  for (const [lang, list] of Object.entries(STOP)) {
    const set = new Set(list)
    let s = 0
    for (const w of words) if (set.has(w)) s++
    if (s > bestScore) { best = lang; bestScore = s }
  }
  return best
}
