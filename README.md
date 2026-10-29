# prompt-polish

A Claude Code mod that polishes your prompt while you type it. When you pause, it:

- fixes spelling, grammar, punctuation and word choice,
- sharpens what you are asking for, using the last few messages of the conversation to know what "it" or "that file" means,
- translates Chinese, or Chinese mixed into English, into one natural English message.

The result appears in a row just above the input, as a diff and as clean text:

```
Optimized: Check why the config loader ~~crash~~ crashes when the file is missing, ~~并且~~ and add a warning log.
→ Check why the config loader crashes when the file is missing, and add a warning log.
[Accept] [Dismiss]
```

Removed words are struck through in red and added words are bold in green. **Accept** puts the polished text in your input box, where you can still edit it, and you press Enter to send it. **Dismiss** keeps what you typed. Nothing is changed or sent without you.

## Requirements

- Claude Code 2.1.308 or newer, in the terminal or in the desktop app's Code tab. Check with `claude --version`; with Homebrew, update with `brew upgrade --cask claude-code`.
- Nothing else: the mod calls Claude Haiku through your own Claude Code sign-in. There is no API key to set and no other service involved.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install prompt-polish --marketplace lexsix/prompt-polish
```

Answer `y` to add the marketplace, then press Enter to install for your user, so every session loads it. The mod is active right away.

Or from a shell:

```bash
claude plugin install prompt-polish --marketplace lexsix/prompt-polish
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `lexsix/prompt-polish`, then **Add plugin**. A mod installed from a terminal for your user loads in the desktop app too.

To update later:

```bash
claude plugin update prompt-polish
```

then run `/reload-plugins` in an open session, or start a new one.

## Use

Type as usual. When you pause, a spinning "⠋ Polishing…" appears above the input, and the suggestion takes its place about two seconds later. Keep typing and an earlier suggestion dims with "updating after you pause…", then shows the spinner once you pause again, so you never accept one made for an older draft. If the draft needs no changes, the spinner just goes away.

- **Accept:** click it. In the terminal you can also press `ctrl+x` then `tab` to move into the row, then `a`.
- **Dismiss:** click it, or `x` once the row has the focus.

### Modes and commands

| Command | What it does |
| --- | --- |
| `/polish optimize` | The default. Fixes the wording, makes the ask clear and ordered, and uses the recent conversation for context. |
| `/polish fix` | Fixes spelling, grammar and word choice only, and keeps your length and tone. |
| `/polish off`, `/polish on` | Turns the mod off or on. `/polish` alone toggles it. |
| `/polish stats` | Shows how long the model calls take, how many drafts were answered from memory and how many slow calls were backed up. |

The mode and the on/off switch are remembered across sessions. Both modes write English and translate any Chinese.

### What it leaves alone

- Slash commands (`/…`) and shell commands (`!…`).
- English drafts under 12 characters or without a space, and anything over 4,000 characters. Any draft with Chinese in it is polished, however short.
- Code, inline code, file paths, URLs, `@`-mentions, identifiers and quoted error text, which the model is told to keep exactly as written.

### On a phone

Over Remote Control from a phone there is no live preview, so the mod polishes the prompt when you send it. In optimize mode Claude also receives your original wording, with an instruction to follow it wherever the rewrite changed your meaning.

## Privacy and cost

- Your draft goes to Claude Haiku through your Claude Code account, the same way Claude Code's own requests do. In optimize mode, so do up to the last 4 messages of the conversation (at most 3,000 characters). Nothing goes anywhere else.
- Each pause in typing costs one small Haiku call. Answers are remembered for the current turn, so a trailing space, a backspace or an undo back to an earlier draft costs nothing.
- A call takes about two seconds however short the draft, and an occasional one takes five or more. A call still unanswered after 2.5 seconds is sent a second time and the first answer is used, so a slow call costs one extra small request.

## Run it from a folder

To try changes without installing, clone the repository and start Claude Code with it:

```bash
git clone https://github.com/lexsix/prompt-polish.git
claude --plugin-dir ./prompt-polish
```

To load your clone in every session, the desktop app's included, add its absolute path to the `env` block of `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/absolute/path/to/prompt-polish"
  }
}
```

An interactive terminal session reloads the mod when you save a file in that folder. To check a change:

```bash
claude plugin validate ./prompt-polish
```

```bash
claude plugin test ./prompt-polish
```

### Files

| File | What it holds |
| --- | --- |
| `hooks/register.tsx` | The hooks: watching the draft, the row above the input, the `/polish` command, the phone fallback |
| `hooks/polish.ts` | The instructions to the model, the skip rules, the conversation excerpt and the word diff |
| `hooks/register.test.tsx` | The tests |
| `types/index.d.ts` | The types of the values the mod keeps for a session |
| `.claude-plugin/plugin.json` | The mod's manifest |
| `.claude-plugin/marketplace.json` | Makes this repository a marketplace, so it installs with one line |

## License

MIT. See [LICENSE](LICENSE).
