import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'

import {
  endsAWord,
  readPolished,
  recentExcerpt,
  wordDiff,
  worthPolishing,
} from './polish'

const DRAFT = 'i has a question about this functon and how it work'
const POLISHED = 'I have a question about this function and how it works'
const EARLIER = 'parseConfig in src/config.ts returns null on bad input.'
const PRESENTATION = { isFullscreen: false, columns: 80 }

const band = <P extends RenderSurface>(surface: P) =>
  ({
    plugin: 'prompt-polish',
    surface,
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 12,
      bodyColumns: 80,
      scroll: { offset: 0, bodyRows: 12 },
      view: {},
    },
  }) as const

// Nothing sits beneath the plugin: each hook here stands for the engine.
const engine = (on: On, surfaces: RenderSurface[]) => {
  const asked: string[] = []
  const sent: { text: string; context: readonly string[] }[] = []
  const reads = { messages: 0 }

  mock.store(on)
  mock.clock(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'polish' } }))
  on('session.surfaces', () => ({ value: surfaces }))
  on('session.messages', () => {
    reads.messages += 1

    return { value: [{ role: 'assistant', text: EARLIER, toolUses: [] }] }
  })
  on('model.complete', (_, e) => {
    asked.push(String(e.prompt))

    return {
      value: {
        isAnswered: true,
        text: `<polished>\n${POLISHED}\n</polished>`,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    }
  })
  on('prompt.submit', (_, e) => {
    sent.push({ text: e.text, context: e.context ?? [] })

    return { text: e.text }
  })

  return { asked, sent, reads }
}

test('a draft polished once is answered from memory, and the conversation read once', async ($, on) => {
  const { asked, sent, reads } = engine(on, ['mobile'])
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  const other = 'and also check how the cache invalidates itself when a file changes'

  await $.prompt.submit({ text: DRAFT, wait: false, origin: { kind: 'sdk' } })
  await $.prompt.submit({ text: `${DRAFT}  `, wait: false, origin: { kind: 'sdk' } })
  await $.prompt.submit({ text: other, wait: false, origin: { kind: 'sdk' } })

  expect(asked.length).toBe(2)
  expect(reads.messages).toBe(1)
  expect(sent.map(one => one.text)).toEqual([POLISHED, POLISHED, POLISHED])

  const stats = await $.command.run({
    command: 'polish',
    args: 'stats',
    origin: { kind: 'sdk' },
    presentation: PRESENTATION,
  })
  expect(stats).toMatchObject({ text: expect.stringContaining('1 draft answered from memory') })
})

test('on a phone, Enter sends the optimized prompt, its context and the original', async ($, on) => {
  const { asked, sent } = engine(on, ['mobile'])
  // The engine's own band, drawn once the mod has nothing to show.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })

  await $.prompt.submit({ text: DRAFT, wait: false, origin: { kind: 'sdk' } })

  expect(asked.length).toBe(1)
  expect(asked[0]).toContain(`<context>\nAssistant: ${EARLIER}`)
  expect(sent.map(one => one.text)).toEqual([POLISHED])
  expect(sent[0]?.context[0]).toContain(DRAFT)

  // Nothing of the mod's pops up once the prompt is sent.
  const ui = await $.ui.mount(band('mobile'))
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

test('fix mode corrects the wording without context or a fallback', async ($, on) => {
  const { asked, sent } = engine(on, ['mobile'])
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })

  await $.command.run({ command: 'polish', args: 'fix', origin: { kind: 'sdk' }, presentation: PRESENTATION })
  await $.prompt.submit({ text: DRAFT, wait: false, origin: { kind: 'sdk' } })

  expect(asked[0]).not.toContain('<context>')
  expect(sent).toEqual([{ text: POLISHED, context: [] }])
})

test('the desktop app leaves Enter alone: the live band does the work', async ($, on) => {
  const { asked, sent } = engine(on, ['desktop'])
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })

  await $.prompt.submit({ text: DRAFT, wait: false, origin: { kind: 'sdk' } })

  expect(asked.length).toBe(0)
  expect(sent.map(one => one.text)).toEqual([DRAFT])
})

test('a terminal session leaves Enter alone: the live band does the work', async ($, on) => {
  const { asked, sent } = engine(on, ['terminal'])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.prompt.submit({ text: DRAFT, wait: false, origin: { kind: 'composer' } })

  expect(asked.length).toBe(0)
  expect(sent.map(one => one.text)).toEqual([DRAFT])
})

test('/polish off stops the desktop polish, and on starts it again', async ($, on) => {
  const { asked, sent } = engine(on, ['mobile'])
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })

  await $.command.run({ command: 'polish', args: 'off', origin: { kind: 'sdk' }, presentation: PRESENTATION })
  await $.prompt.submit({ text: DRAFT, wait: false, origin: { kind: 'sdk' } })
  await $.command.run({ command: 'polish', args: 'on', origin: { kind: 'sdk' }, presentation: PRESENTATION })
  await $.prompt.submit({ text: DRAFT, wait: false, origin: { kind: 'sdk' } })

  expect(sent.map(one => one.text)).toEqual([DRAFT, POLISHED])
  expect(asked.length).toBe(1)
})

test('drafts not worth a model call are skipped', () => {
  expect(worthPolishing('fix it')).toBe(false)
  expect(worthPolishing('/review the last commit please')).toBe(false)
  expect(worthPolishing('!git status --short --branch')).toBe(false)
  expect(worthPolishing(DRAFT)).toBe(true)
})

test('a finished word or IME commit gets the short pause', () => {
  expect(endsAWord('check the loader ')).toBe(true)
  expect(endsAWord('check the loader,')).toBe(true)
  expect(endsAWord('帮我看看')).toBe(true)
  expect(endsAWord('check the load')).toBe(false)
})

test('any Chinese is worth a call, spaces or not', () => {
  expect(worthPolishing('帮我fix这个bug')).toBe(true)
  expect(worthPolishing('看看 src/config.ts')).toBe(true)
  expect(worthPolishing('/review 最近的提交')).toBe(false)
})

test('a mixed-language prompt goes off to be translated on Enter', async ($, on) => {
  const { asked, sent } = engine(on, ['mobile'])
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  const mixed = '帮我看看为什么parseConfig返回null'

  await $.prompt.submit({ text: mixed, wait: false, origin: { kind: 'sdk' } })

  expect(asked[0]).toContain(mixed)
  expect(sent.map(one => one.text)).toEqual([POLISHED])
  expect(sent[0]?.context[0]).toContain(mixed)
})

test('an English translation of Chinese fits the length a fix allows', () => {
  const chinese =
    '我们的配置加载器在文件不存在的时候会直接崩溃，我希望它能够优雅地处理这种情况，使用默认配置继续运行，同时在日志里面打印一条警告信息，告诉用户找不到配置文件。'
  const english =
    "Our config loader crashes outright when the file doesn't exist. I'd like it to handle that case gracefully: keep running with the default config, and log a warning telling the user the config file wasn't found."

  expect(english.length).toBeGreaterThan(chinese.length * 1.6 + 40)
  expect(readPolished(chinese, `<polished>${english}</polished>`, 'fix')).toBe(english)
})

test('only a tagged reply the mode allows counts', () => {
  // Past what a fix may add to the draft, within what an optimize may.
  const longer = `${POLISHED}: what it returns for valid and invalid input, why it returns null on errors, and how callers should handle that.`

  expect(readPolished(DRAFT, `<polished>${POLISHED}</polished>`, 'fix')).toBe(POLISHED)
  expect(readPolished(DRAFT, `<polished>${DRAFT}</polished>`, 'fix')).toBe(null)
  expect(readPolished(DRAFT, 'Sure! Here is how the function works...', 'optimize')).toBe(null)
  expect(readPolished(DRAFT, `<polished>${longer}</polished>`, 'fix')).toBe(null)
  expect(readPolished(DRAFT, `<polished>${longer}</polished>`, 'optimize')).toBe(longer)
  expect(readPolished(DRAFT, `<polished>${POLISHED.repeat(12)}</polished>`, 'optimize')).toBe(null)
})

test('the excerpt keeps the newest messages that carry text, oldest first', () => {
  const excerpt = recentExcerpt([
    { role: 'user', text: 'first' },
    { role: 'assistant', text: '' },
    { role: 'assistant', text: 'second' },
    { role: 'user', text: 'third' },
  ])

  expect(excerpt).toBe('Developer: first\n\nAssistant: second\n\nDeveloper: third')
})

test('the diff marks replaced words', () => {
  expect(wordDiff('i has a cat', 'I have a cat')).toEqual([
    { text: 'i', kind: 'removed' },
    { text: 'I', kind: 'added' },
    { text: ' ', kind: 'same' },
    { text: 'has', kind: 'removed' },
    { text: 'have', kind: 'added' },
    { text: ' a cat', kind: 'same' },
  ])
})

test('the English inside a mixed draft lines up with its translation', () => {
  expect(wordDiff('看看parseConfig为什么', 'Check why parseConfig')).toEqual([
    { text: '看看', kind: 'removed' },
    { text: 'Check why ', kind: 'added' },
    { text: 'parseConfig', kind: 'same' },
    { text: '为什么', kind: 'removed' },
  ])

  const runs = wordDiff(
    'Check why config loader crash when file missing, 并且 add a warning log.',
    'Check why the config loader crashes when the file is missing, and add a warning log.',
  )
  expect(runs).toContainEqual({ text: '并且', kind: 'removed' })
  expect(runs.filter(run => run.kind === 'same').map(run => run.text).join('')).toContain(
    'warning log.',
  )
})
