/**
 * 把英文拼写词典固定到 src/diagnostics/dict/en.txt。
 *
 *   npm run dict         从上游重新拉一份（需要网络）
 *   npm run dict:check   离线校验词典还在、规模没缩水（构建时跑）
 *
 * 为什么用「词频表前 N 名」而不是完整词典：
 *   完整词典（27 万词）压完也有 700KB 上下，而前 2 万词已经覆盖日常英文的绝大多数。
 *   剩下的长尾词交给用户在「忽略的单词」里补——拼写检查本来就是这么用的。
 *
 * 上游：hermitdave/FrequencyWords（MIT），由 OpenSubtitles 语料统计而来。
 * 处理：只留纯字母/撇号的词，去掉撇号（don't → dont），去重，取词频前 20000。
 * 词表是数据不是代码，所以跟 vendor/ 一样「脚本生成 + 提交产物」，构建时不联网。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'src/diagnostics/dict/en.txt')
const SRC = 'https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/en/en_50k.txt'
const LIMIT = 20000
/** 少于这个数就认为文件被弄坏了，构建时直接失败 */
const MIN_WORDS = 15000

const mode = process.argv.includes('--check') ? 'check' : 'pull'

async function readWords() {
  const text = await readFile(OUT, 'utf8')
  return text.split('\n').filter(Boolean)
}

async function pull() {
  const res = await fetch(SRC)
  if (!res.ok) throw new Error(`拉取词表失败：${res.status} ${res.statusText}`)
  const raw = await res.text()

  const seen = new Set()
  for (const line of raw.split('\n')) {
    const word = line.split(' ')[0]
    if (!/^[a-z']+$/.test(word)) continue
    const clean = word.replace(/'/g, '')
    // 3 个字母起：1~2 个字母的「词」既没有拼写价值，也全是缩写干扰
    if (clean.length < 3) continue
    if (seen.has(clean)) continue
    seen.add(clean)
    if (seen.size >= LIMIT) break
  }

  if (seen.size < MIN_WORDS) throw new Error(`只凑到 ${seen.size} 个词，上游格式可能变了`)

  await mkdir(path.dirname(OUT), { recursive: true })
  await writeFile(OUT, `${[...seen].join('\n')}\n`, 'utf8')
  console.log(`词典已更新：${seen.size} 词 → ${path.relative(ROOT, OUT)}`)
}

async function check() {
  const words = await readWords()
  if (words.length < MIN_WORDS) {
    throw new Error(`词典只有 ${words.length} 个词（至少要 ${MIN_WORDS}），先跑 npm run dict`)
  }
  console.log(`词典就绪：${words.length} 词`)
}

await (mode === 'check' ? check() : pull())
