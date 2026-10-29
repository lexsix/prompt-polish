// `fix` corrects the wording only; `optimize` also sharpens what it asks for.
export type Mode = 'fix' | 'optimize'

// One run of a word diff between the draft and its polished version.
export type Segment = { text: string; kind: 'same' | 'added' | 'removed' }

// The live suggestion the terminal band shows for the draft in the box.
// `isStale` once the person typed past the draft it was made for.
export type Preview = {
  mode: Mode
  draft: string
  polished: string
  segments: Segment[]
  isStale: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'prompt-polish': {
      preview: Shaped<Preview | null>
    }
  }
}
