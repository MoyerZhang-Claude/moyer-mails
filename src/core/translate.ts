import { createHash } from 'node:crypto'
import { detectLang, langInfo, normalizeLang } from '@shared/langs'
import type { Settings, TranslateRequest, TranslateResult } from '@shared/types'
import type { Db } from './db'
import type { Host } from './host'
import { UserError } from './util'

type Provider = (texts: string[], req: TranslateRequest, settings: Settings, host: Host) => Promise<{ texts: string[]; detected?: string }>

/** 把条目按字符数分组，避免单次请求过大 */
function chunk(texts: string[], maxChars: number, maxItems: number): number[][] {
  const groups: number[][] = []
  let cur: number[] = []
  let size = 0
  texts.forEach((t, i) => {
    if (cur.length && (size + t.length > maxChars || cur.length >= maxItems)) {
      groups.push(cur)
      cur = []
      size = 0
    }
    cur.push(i)
    size += t.length
  })
  if (cur.length) groups.push(cur)
  return groups
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return out
}

function majority(list: (string | undefined)[]): string | undefined {
  const counts = new Map<string, number>()
  for (const l of list) if (l) counts.set(l, (counts.get(l) ?? 0) + 1)
  let best: string | undefined
  let n = 0
  for (const [k, v] of counts) if (v > n) { best = k; n = v }
  return best
}

// ---------------- Google 翻译（免费接口，一次请求翻译多段，保留 HTML 标签） ----------------
const google: Provider = async (texts, req, _settings, host) => {
  const tl = langInfo(req.to)?.google ?? req.to
  const sl = req.from ? langInfo(req.from)?.google ?? 'auto' : 'auto'
  const groups = chunk(texts, 4000, 50)
  const out: string[] = new Array(texts.length)
  const detected: (string | undefined)[] = []
  await mapLimit(groups, 3, async (idx) => {
    const body = new URLSearchParams()
    for (const i of idx) body.append('q', texts[i])
    const url = `https://translate.googleapis.com/translate_a/t?client=gtx&sl=${sl}&tl=${tl}&format=${req.format === 'html' ? 'html' : 'text'}`
    let res: Response
    try {
      res = await host.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: body.toString()
      })
    } catch (err) {
      throw new UserError(`连不上 Google 翻译（${(err as Error).message}）。大陆网络需要代理，或者在 设置 → 翻译 换成其他翻译服务。`)
    }
    if (!res.ok) throw new UserError(`Google 翻译出错（${res.status}）。可以稍后再试，或换一个翻译服务。`)
    const json = (await res.json()) as unknown
    const list = Array.isArray(json) ? json : [json]
    idx.forEach((i, k) => {
      const item = list[k] as unknown
      if (Array.isArray(item)) {
        out[i] = String(item[0] ?? texts[i])
        detected.push(typeof item[1] === 'string' ? item[1] : undefined)
      } else out[i] = typeof item === 'string' ? item : texts[i]
    })
  })
  return { texts: out, detected: normalizeLang(majority(detected)) ?? undefined }
}

// ---------------- 微软 Azure 翻译（官方接口，每月 200 万字符免费） ----------------
const azure: Provider = async (texts, req, settings, host) => {
  const { key, region } = settings.translate.azure
  if (!key.trim()) throw new UserError('还没有填写 Azure 翻译的密钥（设置 → 翻译）。')
  const to = langInfo(req.to)?.ms ?? req.to
  const from = req.from ? langInfo(req.from)?.ms : undefined
  const groups = chunk(texts, 40_000, 900)
  const out: string[] = new Array(texts.length)
  const detected: (string | undefined)[] = []
  await mapLimit(groups, 3, async (idx) => {
    const params = new URLSearchParams({ 'api-version': '3.0', to, textType: req.format === 'html' ? 'html' : 'plain' })
    if (from) params.set('from', from)
    const headers: Record<string, string> = { 'Ocp-Apim-Subscription-Key': key.trim(), 'Content-Type': 'application/json' }
    if (region.trim()) headers['Ocp-Apim-Subscription-Region'] = region.trim()
    const res = await host.fetch(`https://api.cognitive.microsofttranslator.com/translate?${params}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(idx.map((i) => ({ Text: texts[i] })))
    })
    if (!res.ok) throw new UserError(`微软翻译出错（${res.status}）：${(await res.text()).slice(0, 200)}`)
    const json = (await res.json()) as { detectedLanguage?: { language: string }; translations: { text: string }[] }[]
    json.forEach((r, k) => {
      out[idx[k]] = r.translations?.[0]?.text ?? texts[idx[k]]
      detected.push(r.detectedLanguage?.language)
    })
  })
  return { texts: out, detected: normalizeLang(majority(detected)) ?? undefined }
}

// ---------------- 大模型（OpenAI 兼容接口） ----------------
const llm: Provider = async (texts, req, settings, host) => {
  const { baseUrl, apiKey, model } = settings.translate.llm
  if (!apiKey) throw new UserError('还没有填写大模型的 API Key（设置 → 翻译）。')
  const langName = langInfo(req.to)?.en ?? req.to
  const system =
    `You are a professional translator. Translate every string in the JSON array sent by the user into ${langName}. ` +
    `Rules: return a JSON array with exactly the same length and order; ` +
    (req.format === 'html' ? 'strings may contain HTML tags — keep every tag and attribute unchanged and translate only the human-readable text; ' : '') +
    `keep URLs, email addresses, numbers, code and product names unchanged; keep the original tone and formatting; ` +
    `if a string is already in ${langName}, return it unchanged. Reply with the JSON array only, no explanations.`
  const groups = chunk(texts, 3000, 60)
  const out: string[] = new Array(texts.length)
  await mapLimit(groups, 3, async (idx) => {
    const res = await host.fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify(idx.map((i) => texts[i])) }
        ]
      })
    })
    if (!res.ok) throw new UserError(`大模型翻译出错（${res.status}）：${(await res.text()).slice(0, 200)}`)
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    let content = json.choices?.[0]?.message?.content ?? ''
    content = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
    let arr: unknown
    try {
      arr = JSON.parse(content)
    } catch {
      arr = null
    }
    if (Array.isArray(arr) && arr.length === idx.length) {
      idx.forEach((i, k) => (out[i] = String(arr[k] ?? texts[i])))
    } else if (idx.length === 1) {
      out[idx[0]] = content
    } else {
      throw new UserError('大模型返回的格式不对，请换个模型或重试。')
    }
  })
  return { texts: out, detected: detectLang(texts.join(' ').replace(/<[^>]+>/g, ' ')) ?? undefined }
}

// ---------------- DeepL ----------------
const deepl: Provider = async (texts, req, settings, host) => {
  const key = settings.translate.deepl.apiKey.trim()
  if (!key) throw new UserError('还没有填写 DeepL API Key（设置 → 翻译）。')
  const target = langInfo(req.to)?.deepl
  if (!target) throw new UserError('DeepL 不支持这个目标语言，请换一个翻译服务。')
  const base = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com'
  const groups = chunk(texts, 100_000, 50)
  const out: string[] = new Array(texts.length)
  const detected: (string | undefined)[] = []
  await mapLimit(groups, 2, async (idx) => {
    const body: Record<string, unknown> = { text: idx.map((i) => texts[i]), target_lang: target }
    if (req.format === 'html') body.tag_handling = 'html'
    const res = await host.fetch(`${base}/v2/translate`, {
      method: 'POST',
      headers: { Authorization: `DeepL-Auth-Key ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!res.ok) throw new UserError(`DeepL 翻译出错（${res.status}）`)
    const json = (await res.json()) as { translations: { text: string; detected_source_language?: string }[] }
    json.translations.forEach((t, k) => {
      out[idx[k]] = t.text
      detected.push(t.detected_source_language)
    })
  })
  return { texts: out, detected: normalizeLang(majority(detected)) ?? undefined }
}

const PROVIDERS: Record<Settings['translate']['provider'], Provider> = { google, azure, llm, deepl }

export class Translator {
  constructor(private db: Db, private host: Host) {}

  private key(provider: string, req: TranslateRequest, text: string) {
    return createHash('sha1').update(`${provider}\n${req.to}\n${req.format ?? 'text'}\n${text}`).digest('hex')
  }

  async translate(req: TranslateRequest, settings: Settings): Promise<TranslateResult> {
    const provider = settings.translate.provider
    const results: string[] = new Array(req.texts.length)
    const missing: number[] = []
    req.texts.forEach((t, i) => {
      if (!t.trim()) {
        results[i] = t
        return
      }
      const hit = this.db.get<{ result: string }>('SELECT result FROM translations WHERE key = ?', this.key(provider, req, t))
      if (hit) results[i] = hit.result
      else missing.push(i)
    })
    let detected: string | undefined
    if (missing.length) {
      const run = PROVIDERS[provider] ?? google
    const res = await run(missing.map((i) => req.texts[i]), req, settings, this.host)
      detected = res.detected
      this.db.tx(() => {
        missing.forEach((i, k) => {
          results[i] = res.texts[k] ?? req.texts[i]
          this.db.run(
            'INSERT OR REPLACE INTO translations (key, result, created) VALUES (?, ?, ?)',
            this.key(provider, req, req.texts[i]),
            results[i],
            Date.now()
          )
        })
      })
    }
    return { texts: results, detected: detected ?? detectLang(req.texts.join(' ').replace(/<[^>]+>/g, ' ')) ?? undefined }
  }

  /** 定期清理太旧的翻译缓存 */
  prune(days = 60) {
    this.db.run('DELETE FROM translations WHERE created < ?', Date.now() - days * 86_400_000)
  }
}
