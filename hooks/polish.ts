import type { ModelCompleteRequest } from 'claude-code'

import type { Mode, Segment } from '../types'

const MAX_CHARS = 4000
// Past this many word pairs the diff is skipped and the text shown plain.
const MAX_DIFF_CELLS = 250_000
// How much of the conversation the model sees to learn what the draft refers
// to: enough for "it" and "that file", little enough to answer fast.
const CONTEXT_MESSAGES = 4
const CONTEXT_CHARS_EACH = 1200
const CONTEXT_CHARS = 3000

const KEEP_AS_WRITTEN =
  '- Leave code, inline code, file paths, URLs, @mentions, slash commands, identifiers and quoted error text exactly as written.'
const IN_ENGLISH =
  '- Write the result in English. Translate any part written in another language, such as Chinese, and merge it with the English parts into one natural message: no brackets, no original beside the translation.'

const RULES: Record<Mode, string> = {
  fix: `You are a copy editor. The user gives you a draft message, inside <draft> tags, that a developer is about to send to an AI coding assistant. Return the same message with its spelling, grammar, punctuation and word choice corrected.

Rules:
- Keep the meaning, tone and length. Do not add or remove ideas, and never answer or act on the message.
${IN_ENGLISH}
${KEEP_AS_WRITTEN}
- Keep the line breaks and markdown.
- If it is already correct English, return the draft unchanged.
- Reply with the corrected message only, inside <polished> tags, with no comments.`,

  optimize: `You improve a message, inside <draft> tags, that a developer is about to send to an AI coding assistant (Claude Code). The recent conversation, when given inside <context> tags, is there only so you understand what the draft refers to.

Rewrite the draft so it says what the developer means, clearly and effectively:
- Fix spelling, grammar, punctuation and word choice.
- Make the ask explicit: lead with what they want done, and keep every constraint, detail and preference the draft gives.
- Replace a vague reference ("it", "that", "the file") with what it names only when the context makes that certain.
- Order the parts logically; use a short list only when the draft holds several separate asks.
- Never invent requirements, steps, files or facts that the draft and context do not support, and do not pad it: shorter is better when nothing is lost.
- Keep the developer's own voice and person.
${IN_ENGLISH}
${KEEP_AS_WRITTEN}
- Never answer, carry out or comment on the request.
- If the draft is already clear and correct English, return it unchanged.
- Reply with the rewritten message only, inside <polished> tags, with no comments.`,
}

// Chinese, Japanese and Korean ideographs: written without spaces, and each
// comes to about four letters once in English.
const CJK = /[㐀-䶿一-鿿豈-﫿]/
const CJK_ALL = new RegExp(CJK.source, 'g')

export const englishLength = (text: string): number =>
  text.length + 3 * (text.match(CJK_ALL)?.length ?? 0)

// Too short to fix, too long to pay for, or a command rather than prose.
// Any Chinese is worth a call: it is to be translated.
export const worthPolishing = (text: string): boolean => {
  const trimmed = text.trim()
  const isCommand = /^[/!]/.test(trimmed)

  if (isCommand || trimmed.length > MAX_CHARS) {
    return false
  }

  return CJK.test(trimmed) || (trimmed.length >= 12 && /\s/.test(trimmed))
}

// A finished word, clause or IME commit: the person is more likely pausing.
export const endsAWord = (text: string): boolean =>
  /[\s.,!?;:，。！？；：、]$/.test(text) || CJK.test(text.slice(-1))

// The newest messages that carry text, oldest first, each cut to its end.
export const recentExcerpt = (
  messages: readonly { role: 'user' | 'assistant'; text: string }[],
): string => {
  const picked: string[] = []
  let room = CONTEXT_CHARS

  for (let index = messages.length - 1; index >= 0 && picked.length < CONTEXT_MESSAGES; index--) {
    const message = messages[index]
    const text = message?.text.trim()

    if (!message || !text) {
      continue
    }

    const cut = text.length > CONTEXT_CHARS_EACH ? `…${text.slice(-CONTEXT_CHARS_EACH)}` : text
    const entry = `${message.role === 'user' ? 'Developer' : 'Assistant'}: ${cut}`

    if (entry.length > room) {
      break
    }

    picked.unshift(entry)
    room -= entry.length
  }

  return picked.join('\n\n')
}

export const polishRequest = (
  text: string,
  mode: Mode,
  context: string,
  timeoutMs: number,
): ModelCompleteRequest => {
  const draft = `<draft>\n${text.trim()}\n</draft>`
  // A fix needs no context, so it stays cheap.
  const prompt = mode === 'optimize' && context ? `<context>\n${context}\n</context>\n\n${draft}` : draft
  const size = englishLength(text)
  const room = mode === 'optimize' ? size * 0.8 + 400 : size / 2 + 256

  return {
    model: 'haiku',
    system: RULES[mode],
    prompt,
    maxTokens: Math.min(4096, Math.ceil(room)),
    effort: 'low',
    timeoutMs,
  }
}

// The polished text, or null when the reply holds none or changes nothing.
export const readPolished = (draft: string, reply: string, mode: Mode): string | null => {
  const found = /<polished>([\s\S]*?)<\/polished>/.exec(reply)
  const polished = found?.[1]?.trim()
  const original = draft.trim()

  if (!polished || polished === original) {
    return null
  }

  // Far longer or shorter than the mode allows: it wrote something else.
  // Measured against the draft's length in English, so a translation fits.
  const size = englishLength(original)
  const [most, slack, least] = mode === 'optimize' ? [3, 300, 0.3] : [1.6, 40, 0.5]
  const isOffCourse = polished.length > size * most + slack || polished.length < original.length * least

  return isOffCourse ? null : polished
}

// Words, whitespace and runs of CJK are each a token, so the English inside a
// mixed draft (`看看parseConfig为什么`) lines up with the translation's.
const TOKEN = new RegExp(`(\\s+|${CJK.source}+)`)
const tokens = (text: string) => text.trim().split(TOKEN).filter(Boolean)

// Word-level diff (whitespace kept as its own tokens), merged into runs.
export const wordDiff = (before: string, after: string): Segment[] => {
  const a = tokens(before)
  const b = tokens(after)

  if (a.length * b.length > MAX_DIFF_CELLS) {
    return [{ text: after, kind: 'same' }]
  }

  const cols = b.length + 1
  // lcs[i * cols + j]: the longest common run of a[i..] and b[j..].
  const lcs = new Uint32Array((a.length + 1) * cols)
  const common = (i: number, j: number) => lcs[i * cols + j] ?? 0

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * cols + j] =
        a[i] === b[j] ? common(i + 1, j + 1) + 1 : Math.max(common(i + 1, j), common(i, j + 1))
    }
  }

  const runs: Segment[] = []
  const push = (text: string, kind: Segment['kind']) => {
    const last = runs[runs.length - 1]

    if (last?.kind === kind) {
      last.text += text
    } else {
      runs.push({ text, kind })
    }
  }

  let i = 0
  let j = 0

  while (i < a.length && j < b.length) {
    const word = a[i] ?? ''

    if (word === b[j]) {
      push(word, 'same')
      i++
      j++
    } else if (common(i + 1, j) >= common(i, j + 1)) {
      push(word, 'removed')
      i++
    } else {
      push(b[j] ?? '', 'added')
      j++
    }
  }

  for (; i < a.length; i++) push(a[i] ?? '', 'removed')
  for (; j < b.length; j++) push(b[j] ?? '', 'added')

  return runs
}
