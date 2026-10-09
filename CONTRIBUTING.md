# Contributing to ZiPlayer

Thanks for your interest in improving **ZiPlayer** — a modular Discord voice player with a plugin system for `@discordjs/voice`.

This guide explains how to set up your dev environment, propose changes, add new plugins, file issues, and open pull requests.
Welcome aboard! 🧑‍💻🎧

---

## Table of contents

- [Code of Conduct](#code-of-conduct)
- [Ways to contribute](#ways-to-contribute)
- [Project structure](#project-structure)
- [Development setup](#development-setup)
- [Running locally](#running-locally)
- [Commit style & branches](#commit-style--branches)
- [Pull request checklist](#pull-request-checklist)
- [Adding a new plugin](#adding-a-new-plugin)
- [Testing](#testing)
- [Documentation](#documentation)
- [Release & versioning](#release--versioning)
- [Security](#security)
- [License](#license)

---

## Code of Conduct

By participating in this project, you agree to uphold a respectful community. We follow the
[Contributor Covenant](https://www.contributor-covenant.org/) Code of Conduct. If this repository adds a dedicated
`CODE_OF_CONDUCT.md`, that document is authoritative.

If you experience or witness unacceptable behavior, please open a confidential issue or contact a maintainer.

---

## Ways to contribute

- **Bug reports:** Describe the environment, steps to reproduce, expected vs. actual behavior, and logs.
- **Feature proposals:** Explain the problem, the user story, and a minimal API sketch if relevant.
- **Docs & examples:** Improve README snippets, example bots, and in‑code JSDoc/tsdoc.
- **Plugins:** Implement sources (e.g., YouTube, SoundCloud, Spotify, etc.) or utility plugins.
- **Performance & DX:** Profiling, memory/GC improvements, build/dev ergonomics.

Before filing a feature request, please search existing issues to avoid duplicates.

---

## Project structure

> Actual folders may evolve; use this as a quick orientation.

```
root
├─ core/         # Player core (managers, queue, events, types)
├─ plugins/      # First‑party plugins and examples for new sources
├─ examples/     # Example bots and usage demos
├─ .github/      # Issue & PR templates, workflows
├─ LICENSE       # MIT license
└─ README.md     # Overview & quick start
```

---

## Development setup

**Prerequisites**

- **Node.js** LTS (≥ 18.x recommended; 20.x+ preferred)
- **npm** (or **pnpm/yarn** if you prefer)
- **FFmpeg** available on your PATH — some plugins need it
- Optional per‑plugin tools (e.g., `yt-dlp`) if a plugin documents them

**1) Fork & clone**

```bash
# replace YOURUSER with your GitHub username
git clone https://github.com/ZiProject/ZiPlayer
cd ZiPlayer
```

**2) Install dependencies**

```bash
npm install
```

**3) Build TypeScript**

```bash
npm run build
```

**4) format (if configured)**

```bash
npm run format
```

> If a script is missing, check each package (`core`, each plugin) for its own `package.json` scripts.

---

## Running locally

The fastest way to validate changes is to run an example bot and play audio in a test guild.

1. Create a **Discord bot** and invite it to a test server with the proper **voice permissions**.
2. Create a `.env` in the example folder you want to run (e.g. `examples/basic-bot`) with at least:

   ```dotenv
   DISCORD_TOKEN=your_bot_token
   GUILD_ID=your_guild_id     # optional but often useful
   ```

3. Start the example:

   ```bash
   cd examples/basic-bot
   npm install
   npm start        # or: npm run dev / npm run start:dev
   ```

4. From a voice channel, use the example’s commands to play a track/playlist.

> **Legal & Platform rules:** Ensure your bot and plugins respect Discord ToS and third‑party content policies.

---

## Commit style & branches

We use **Conventional Commits** to keep a clean history and automate changelogs:

```
<type>(<scope>): <short summary>

# types: feat | fix | docs | refactor | perf | test | build | chore | ci
# scopes (examples): core, plugins-youtube, plugins-soundcloud, examples, repo
```

**Branch names**

- `feat/<short-topic>` — new features
- `fix/<short-topic>` — bug fixes
- `chore/<short-topic>` — tooling/infra

---

## Pull request checklist

- [ ] PR title follows **Conventional Commits**
- [ ] Linked to an issue (or explains the context/motivation clearly)
- [ ] Focused change set (avoid mixing unrelated changes)
- [ ] **Type‑safe**: no `any` unless justified with comments
- [ ] Linted & formatted; no warnings on build
- [ ] New/changed behavior covered by tests (where applicable)
- [ ] Example(s) updated when the public API changes
- [ ] No secrets or tokens in code or history

### CI & reviews

- All PRs must pass CI checks (build, typecheck, lint, tests).
- At least **one maintainer review** is required before merging.

---

## Adding a new plugin

ZiPlayer supports a **plugin architecture** so you can add new sources.

### Design principles

- **Isolated**: avoid coupling to unrelated plugins.
- **Non‑blocking**: network calls should be async; stream delivery should not block the event loop.
- **Errors**: normalize errors and surface them via player events.
- **Quality**: return rich metadata (title, url, duration, thumbnails if available).

### Minimal plugin checklist

- [ ] Exports a class with `name`, `version`
- [ ] Implements `canHandle(query: string): boolean`
- [ ] Implements `search(query: string, requestedBy: string)` → `{ tracks: Track[] }`
- [ ] Implements `getStream(track: Track)` → `{ stream: Readable; type: "arbitrary" | "opus" | ... }`
- [ ] Adds small docs in `plugins/<your-plugin>/README.md`
- [ ] Provides a quick example under `examples/` (optional but helpful)

### Example skeleton (TypeScript)

```ts
import { BasePlugin, Track, SearchResult, StreamInfo } from "ziplayer";

export class MyPlugin extends BasePlugin {
	name = "myplugin";
	version = "1.0.0";

	canHandle(query: string): boolean {
		return query.includes("mysite.com");
	}

	async search(query: string, requestedBy: string): Promise<SearchResult> {
		// Implement search logic
		return {
			tracks: [
				/* ... */
			],
		};
	}

	async getStream(track: Track): Promise<StreamInfo> {
		// Return audio stream
		return { stream, type: "arbitrary" };
	}
}
```

> Tip: Some sources require **FFmpeg** to demux/transcode audio; document any external dependency.

---

## Testing

- Unit tests should target deterministic behavior (queue ops, loop/auto‑play, events).
- Consider **integration tests** for plugins with network I/O mocked.
- Suggested scripts (add as needed):

  ```json
  {
  	"scripts": {
  		"build": "tsc -b",
  		"lint": "eslint .",
  		"format": "prettier --check .",
  		"test": "vitest run"
  	}
  }
  ```

---

## Documentation

- Keep the root `README.md` concise; link to deeper docs in `docs/` or per‑package `README.md`.
- Every public API symbol should have **tsdoc**.
- Update the examples when behavior changes.

---

## Release & versioning

- We follow **Semantic Versioning** (SEMVER): `MAJOR.MINOR.PATCH`.
- Maintainers publish to npm when meaningful changes land. Community PRs are bundled into regular releases.

---

## Security

If you discover a security issue (e.g., arbitrary file writes, command injection in external binaries, or unsafe stream handling),
**do not** open a public issue. Email a maintainer privately or open a security advisory.

Please also avoid shipping API keys or tokens in examples, and ensure any temporary files are cleaned up.

---

## License

By contributing, you agree that your contributions will be licensed under the repository’s [MIT License](./LICENSE).

---

**Thank you for helping make ZiPlayer better!** 🎶
