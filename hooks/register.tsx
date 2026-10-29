import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  ModelCompleteRequest,
  ModelCompleteResult,
  Register,
  Timer,
} from 'claude-code'

import type { Mode, Segment } from '../types'
import {
  endsAWord,
  polishRequest,
  readPolished,
  recentExcerpt,
  wordDiff,
  worthPolishing,
} from './polish'

// Change a tag when its value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const preview = atom({ plugin: 'prompt-polish', key: 'preview' } as const, null, {
  shape: 'preview-2',
})
const loading = atom({ plugin: 'prompt-polish', key: 'loading' } as const, null, {
  shape: 'loading-1',
})

// How long typing must pause before the draft goes off: short once a word
// is finished, longer mid-word, where the person is more likely still typing.
// Each call costs about two seconds whatever its size, so starting it sooner
// is worth more than a request or two the person types past.
const PAUSE_AFTER_WORD_MS = 200
const PAUSE_MID_WORD_MS = 500
// A call still unanswered after this gets a twin, and the first answer wins:
// calls do not queue, and the slow ones are outliers of five seconds and more.
const HEDGE_MS = 2_500
// Enter waits on the polish where there is no live band, so it gets less time.
const LIVE_TIMEOUT_MS = 12_000
const SUBMIT_TIMEOUT_MS = 8_000
// Answers kept per draft, so an undo, a backspace or a trailing space costs nothing.
const MEMO_SIZE = 50
const TIMINGS_KEPT = 20
// Prompts a person typed; the desktop app's arrive as `sdk`, a phone's as `bridge`.
const TYPED_ORIGINS = new Set(['sdk', 'bridge'])
// Every way a person sends what is in their box, the terminal's Enter included.
const SENT_BY_PERSON = new Set(['composer', 'sdk', 'bridge'])

// Module state: a reload starts it over, and `session.start` reads the settings.
let isEnabled = true
let mode: Mode = 'optimize'
// The draft in the box as last seen, trimmed, and the pause before polishing it.
let draft = ''
let timer: Timer | undefined
// Aborted only when polishing is switched off: a request the person typed past
// still runs, and its answer is kept for when they come back to that draft.
let stopAll = new AbortController()
// The conversation excerpt `optimize` reads, fetched once per turn.
let context: Promise<string> | undefined
// Set once the prompt box reports the draft as it is typed (the terminal, the
// desktop app): there the person picks from the band, and Enter sends as typed.
let hasLiveDrafts = false
const memo = new Map<string, string | null>()
const pending = new Map<string, Promise<string | null>>()
const timings: number[] = []
let memoHits = 0
let hedges = 0
// What the mod saw and what last went wrong, for `/polish stats`.
let editsSeen = 0
let polishesStarted = 0
let suggestionsShown = 0
let lastProblem: string | undefined
// Surfaces where the spinner's Client failed: they get the plain text instead.
const spinnerFailedOn = new Set<string>()

// The spinner's value never stops a polish: a refused read or write is noted
// for `/polish stats`, and the polish goes on without the spinner.
async function setLoading($: EngineInterface, next: (now: string | null) => string | null) {
  try {
    await update($, loading, next)
  } catch (error) {
    lastProblem = `spinner state: ${String(error)}`
  }
}

async function readLoading($: EngineInterface): Promise<string | null> {
  try {
    return await read($, loading)
  } catch (error) {
    lastProblem = `spinner state: ${String(error)}`

    return null
  }
}

function memoKey(text: string): string {
  return `${mode}\n${text.trim()}`
}

function remember(key: string, polished: string | null) {
  memo.delete(key)
  memo.set(key, polished)

  const oldest = memo.keys().next().value

  if (memo.size > MEMO_SIZE && oldest !== undefined) {
    memo.delete(oldest)
  }
}

function recentContext($: EngineInterface): Promise<string> {
  context ??= $.session.messages().then(recentExcerpt, () => '')

  return context
}

// One model call, backed up by a twin once it has run HEDGE_MS; the first
// answer wins and the other call is cut.
async function hedgedComplete(
  $: EngineInterface,
  request: ModelCompleteRequest,
  signal: AbortSignal,
): Promise<ModelCompleteResult> {
  const first = new AbortController()
  const second = new AbortController()
  const stopBoth = () => {
    first.abort()
    second.abort()
  }

  if (signal.aborted) {
    stopBoth()
  }

  signal.addEventListener('abort', stopBoth, { once: true })

  let backup: Timer | undefined
  const twin = new Promise<ModelCompleteResult>(resolve => {
    backup = $.clock.after(HEDGE_MS, () => {
      hedges += 1
      void $.model.complete(request, { signal: second.signal }).then(resolve, () => undefined)
    })
  })

  try {
    return await Promise.race([$.model.complete(request, { signal: first.signal }), twin])
  } finally {
    backup?.cancel()
    stopBoth()
    signal.removeEventListener('abort', stopBoth)
  }
}

async function complete(
  $: EngineInterface,
  text: string,
  key: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const as = mode
    const known = as === 'optimize' ? await recentContext($) : ''
    const startedAt = await $.clock.now()
    const reply = await hedgedComplete($, polishRequest(text, as, known, timeoutMs), signal)
    timings.push((await $.clock.now()) - startedAt)
    timings.splice(0, Math.max(0, timings.length - TIMINGS_KEPT))

    if (!reply.isAnswered) {
      lastProblem = `model call: ${reply.reason}${'error' in reply ? ` (${reply.error})` : ''}`

      return null
    }

    const polished = readPolished(text, reply.text, as)
    remember(key, polished)

    return polished
  } catch (error) {
    lastProblem = `model call: ${String(error)}`

    return null
  }
}

// One request per draft: a known answer comes back at once, a running one is shared.
function polish(
  $: EngineInterface,
  text: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string | null> {
  const key = memoKey(text)

  if (memo.has(key)) {
    memoHits += 1

    return Promise.resolve(memo.get(key) ?? null)
  }

  const running = pending.get(key)

  if (running) {
    return running
  }

  const request = complete($, text, key, timeoutMs, signal).finally(() => pending.delete(key))
  pending.set(key, request)

  return request
}

function stopPolishing() {
  timer?.cancel()
  stopAll.abort()
  stopAll = new AbortController()
}

async function polishDraft($: EngineInterface, text: string) {
  const key = text.trim()

  // The person stopped typing and the answer is not known yet: show it is on its way.
  if (!memo.has(memoKey(text))) {
    polishesStarted += 1
    await setLoading($, now => (key === draft ? key : now))
  }

  const polished = await polish($, text, LIVE_TIMEOUT_MS, stopAll.signal)
  await setLoading($, now => (now === key ? null : now))

  if (!isEnabled || key !== draft) {
    return
  }

  suggestionsShown += polished === null ? 0 : 1

  // Checked again as it writes: the draft may have been sent or changed meanwhile.
  await update($, preview, now => {
    if (key !== draft) {
      return now
    }

    return polished === null
      ? null
      : { mode, draft: text, polished, segments: wordDiff(text, polished), isStale: false }
  })
}

// The person sent the draft: nothing of it stays to suggest.
async function forgetDraft($: EngineInterface) {
  draft = ''
  timer?.cancel()
  await update($, preview, () => null)
  await setLoading($, () => null)
}

async function onDraft($: EngineInterface, text: string) {
  const key = text.trim()

  // A cursor move or a trailing space: the suggestion shown still fits.
  if (key === draft) {
    return
  }

  draft = key
  timer?.cancel()
  const shown = await read($, preview)

  // Typing again: whatever was loading was for an older draft.
  if ((await readLoading($)) !== null) {
    await setLoading($, () => null)
  }

  if (!isEnabled || !worthPolishing(text) || key === shown?.polished) {
    if (shown) {
      await update($, preview, () => null)
    }

    return
  }

  // Polished before: no pause, no request.
  if (memo.has(memoKey(text))) {
    await polishDraft($, text)

    return
  }

  if (shown && !shown.isStale) {
    await update($, preview, now => now && { ...now, isStale: true })
  }

  const pause = endsAWord(text) ? PAUSE_AFTER_WORD_MS : PAUSE_MID_WORD_MS
  timer = $.clock.after(pause, () => void polishDraft($, text).catch(noteProblem('polish')))
}

// Accept: the polished prompt goes in the box, for the person's own Enter.
async function acceptPreview($: EngineInterface) {
  const now = await read($, preview)

  if (!now || now.isStale) {
    return
  }

  draft = now.polished
  await update($, preview, () => null)
  await $.prompt.fill({ text: now.polished, mode: 'replace' })
}

// Records what stopped a step, where no one else would hear of it.
function noteProblem(where: string) {
  return (error: unknown) => {
    lastProblem = `${where}: ${String(error)}`
  }
}

function stats(): string {
  const fromMemory = `${memoHits} ${memoHits === 1 ? 'draft' : 'drafts'} answered from memory`
  const backedUp = `${hedges} slow ${hedges === 1 ? 'call' : 'calls'} backed up`
  const status = `Prompt polish is ${isEnabled ? `on, ${mode} mode` : 'off'}.`
  const activity = `Since it loaded: ${editsSeen} edits seen, ${polishesStarted} polishes started, ${suggestionsShown} suggestions shown.`
  const problem = lastProblem ? `Last problem: ${lastProblem}` : 'No problems so far.'

  if (timings.length === 0) {
    return [status, activity, `No model calls yet; ${fromMemory}.`, problem].join('\n')
  }

  const sorted = [...timings].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0
  const last = timings[timings.length - 1] ?? 0
  const calls = `Model calls: median ${Math.round(median)} ms, last ${Math.round(last)} ms (of the last ${timings.length}); ${fromMemory}; ${backedUp}.`

  return [status, activity, calls, problem].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    isEnabled = (await $.store.get('isEnabled')) !== false
    mode = (await $.store.get('mode')) === 'fix' ? 'fix' : 'optimize'
    await $.command.register({
      name: 'polish',
      description: 'Prompt polish: on, off, fix (wording only), optimize (wording and intent) or stats',
      argumentHint: '[on|off|fix|optimize|stats]',
    })
    // Fetched now, so the first polish does not wait on it.
    void recentContext($)

    return next(e)
  })

  on('command.run', { command: 'polish' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg === 'stats') {
      return { text: stats() }
    }

    if (arg === 'fix' || arg === 'optimize') {
      mode = arg
      isEnabled = true
    } else {
      isEnabled = arg === 'on' ? true : arg === 'off' ? false : !isEnabled
    }

    await $.store.set('isEnabled', isEnabled)
    await $.store.set('mode', mode)
    stopPolishing()
    await forgetDraft($)

    if (!isEnabled) {
      return { text: 'Prompt polish is off.' }
    }

    const what = mode === 'fix' ? 'fixes the wording only' : 'fixes the wording and sharpens what you ask for'

    return { text: `Prompt polish is on: ${mode} mode, which ${what}.` }
  })

  // A finished turn adds to what a draft may refer to: read it again now,
  // before the next pause, and forget answers made without it.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    context = undefined
    memo.clear()
    void recentContext($)

    return result
  })

  // The person types; the band above the prompt follows.
  on('prompt.edit', async ($, e, next) => {
    hasLiveDrafts = true
    editsSeen += 1
    const box = await next(e)
    void onDraft($, box.text).catch(noteProblem('typing'))

    return box
  })

  // The spinner failed where it was drawn: that surface gets plain text, and
  // the engine draws the band again on its own.
  on('ui.fault', ($, e, next) => {
    if (e.module.endsWith('spinner.ts')) {
      spinnerFailedOn.add(e.surface)
    }

    lastProblem = `spinner on ${e.surface} (${e.phase}): ${e.reason}`

    return next(e)
  })

  // A history recall, a clear, a submit or a fill: no keystroke carried it.
  on('prompt.change', async ($, e, next) => {
    hasLiveDrafts = true
    const result = await next(e)
    await onDraft($, e.text)

    return result
  })

  // Where no prompt box reports the draft as it is typed (a phone over Remote
  // Control, a client that sends only whole prompts), polish on Enter.
  on('prompt.submit', async ($, e, next) => {
    // Sent, so its preview goes, even where the box reports no clearing.
    if (!e.isMeta && SENT_BY_PERSON.has(e.origin.kind)) {
      await forgetDraft($)
    }

    const isTyped = !e.command && !e.isMeta && TYPED_ORIGINS.has(e.origin.kind)

    if (!isTyped) {
      return next(e)
    }

    // The terminal and the desktop app show the band as the person types, so
    // there Enter sends as typed, even before the first edit since a reload.
    const surfaces = await $.session.surfaces()
    const hasLiveBox = hasLiveDrafts || surfaces.includes('terminal') || surfaces.includes('desktop')

    if (!isEnabled || hasLiveBox || !worthPolishing(e.text)) {
      return next(e)
    }

    const polished = await polish($, e.text, SUBMIT_TIMEOUT_MS, next.signal)

    if (polished === null) {
      return next(e)
    }

    // An optimized prompt was never seen before it went: the model keeps the
    // person's own words beside it, to fall back on where the two disagree.
    const original =
      mode === 'optimize'
        ? [
            `The prompt-polish plugin rewrote the user's message for clarity before sending it. Their own words were:\n\n${e.text}\n\nWhere the rewrite and these differ in meaning, follow their own words.`,
          ]
        : []

    return next({ ...e, text: polished, context: [...(e.context ?? []), ...original] })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const shown = await read($, preview)
    const pending = await readLoading($)

    if (e.props.hasSurvey || (!shown && pending === null)) {
      return next(e)
    }

    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    // Animated where the surface runs a Client: the terminal and the desktop
    // app. The table lists one on other surfaces too, which refuse it, and a
    // surface where it failed once gets the plain text from then on.
    const runsClient =
      (e.surface === 'terminal' || e.surface === 'desktop') && !spinnerFailedOn.has(e.surface)
    const polishing =
      runsClient && 'Client' in elements ? (
        <elements.Client key="polishing" module="./spinner.ts" props="Polishing…" />
      ) : (
        <Text dimColor>Polishing…</Text>
      )

    if (!shown) {
      return <Box>{polishing}</Box>
    }

    // Removed words struck through in red, added ones bold in green.
    const changes = (segments: Segment[]) => {
      return segments.flatMap((run, index) => {
        if (run.kind === 'same') {
          return [run.text]
        }

        if (run.kind === 'added') {
          return [
            <Text color="success" bold>
              {run.text}
            </Text>,
          ]
        }

        const isReplaced = segments[index + 1]?.kind === 'added'

        return [
          <Text color="error" strikethrough>
            {run.text}
          </Text>,
          ...(isReplaced ? [' '] : []),
        ]
      })
    }

    return (
      <Box flexDirection="column">
        <Text wrap="wrap" dimColor={shown.isStale}>
          <Text color="suggestion" bold>
            Polished:{' '}
          </Text>
          {changes(shown.segments)}
        </Text>
        <Text wrap="wrap" dimColor={shown.isStale}>
          <Text dimColor>→ </Text>
          {shown.polished}
        </Text>
        <Box flexDirection="row" gap={1}>
          {shown.isStale ? (
            pending !== null ? polishing : <Text dimColor>updating after you pause…</Text>
          ) : (
            <Button
              key="accept"
              label="Accept"
              hotkey="a"
              variant="primary"
              onPress={() => acceptPreview($)}
            />
          )}
          <Button
            key="dismiss"
            label="Dismiss"
            hotkey="x"
            onPress={() => update($, preview, () => null)}
          />
          {e.surface === 'terminal' && !shown.isStale && (
            <Text dimColor>click, or ctrl+x tab then a</Text>
          )}
        </Box>
      </Box>
    )
  })
}
