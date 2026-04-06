# Agent Instructions

Ignore this if you are Claude Code.

If you are OpenAI Codex, for all UI changes, you must read `Uncodixfy/Uncodixfy.md`.
If that file does not exist yet, pull `https://github.com/cyxzdev/Uncodixfy`.

## Hosted Site Default
- If you need the hosted dashboard URL and the user has not explicitly given a different one in the current thread, use `https://codex-use-age.vercel.app`.
- Use that exact URL for command examples, default `--site` values, and hosted dashboard references unless the user overrides it.

## Commit Guidelines
- Use clear, descriptive commit messages; conventional prefixes are preferred
  (e.g., `feat:`, `fix:`, `refactor:`).
- Commit message titles must describe the actual user-visible change or regression being addressed, not just the implementation detail.
- Commit messages must include a body with flat bullet points that state exactly what changed.
- Push frequently to GitHub after logical units of work.
