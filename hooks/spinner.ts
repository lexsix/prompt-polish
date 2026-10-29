import type { ClientModule } from 'claude-code'

// The loading spinner, turned by the surface's own frame clock so the band
// is not redrawn for each frame.
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const FRAME_MS = 80

const Spinner: ClientModule<string, number> = (label, surface) => {
  if (surface.state === undefined) {
    let frame = 0

    surface.every(FRAME_MS, () => {
      frame = (frame + 1) % FRAMES.length
      surface.setState(frame)
    })
    surface.setState(frame)
  }

  return surface.elements.Text({
    color: 'suggestion',
    children: `${FRAMES[surface.state ?? 0] ?? FRAMES[0]} ${label}`,
  })
}

export default Spinner
