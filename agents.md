# Agent Instructions

Ignore this if you are Claude Code.

If you are OpenAI Codex, for all UI changes, you must read `Uncodixfy/Uncodixfy.md`.
If that file does not exist yet, pull `https://github.com/cyxzdev/Uncodixfy`.

## Hosted Site Default
- If you need the hosted dashboard URL and the user has not explicitly given a different one in the current thread, use `https://codex-use-age-tario-yous-projects.vercel.app`.
- Use that exact URL for command examples, default `--site` values, and hosted dashboard references unless the user overrides it.
- Do not assume `https://codex-use-age.vercel.app` belongs to this project. That hostname is not managed by the linked `codex-use-age` Vercel project and may point somewhere else entirely.
- Vercel-hosted domain attachment is configured in Vercel project settings, not in this repo. `.vercel/project.json` only links the local repo to the Vercel project; it does not define which `*.vercel.app` hostnames are attached.
- The stable project-owned hostname is `https://codex-use-age-tario-yous-projects.vercel.app`. It is attached at the Vercel project level, so future production deployments should continue updating it automatically.
- If the hosted site ever looks stale again, verify the actual project-level domains and production aliases in Vercel before assuming the latest deployment is broken.

## Commit Guidelines
- Use clear, descriptive commit messages; conventional prefixes are preferred
  (e.g., `feat:`, `fix:`, `refactor:`).
- Commit message titles must describe the actual user-visible change or regression being addressed, not just the implementation detail.
- Commit messages must include a body with flat bullet points that state exactly what changed.
- Push frequently to GitHub after logical units of work.
