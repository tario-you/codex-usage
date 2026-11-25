# Agent Instructions

- Rank live paid Codex plans by usable room across Pro and Pro Lite. Cancellation at a future paid end preserves access until that end; ended, lost-access and unusably stale sign-ins have no rank or switch action and show gray. Hide Free plans. Saved Proton sessions are switcher-only: the switcher may pick them; agents never inspect, copy, refresh, replace, revoke, repair or reauthenticate them, or regain lost-email access with saved tokens.
- (11-05 about 2:34 AM GMT+8, his words paraphrased: he is signed in to tgyou168 in the Claude app and electricfan244 is live too, yet the dashboard showed both signed out) An account shows signed out only when no route on his Mac (the Claude app, the CLI or a saved login) holds it live: a saved login refused renewal alone never marks it so, the newer reading wins, and a real reading replaces signed-out marks made after it. [check: `tests/claude-logins.test.js` "a dead saved login the app has read since", `tests/unlink-keeps-machine.test.js` "a real reading replaces signed-out marks"]
- (11-06 about 3:04 AM GMT+8, his words: "this plan is in the switching shit bruhh", tgyou168 grey with "last read 24h ago: room unknown, not counted") A pool plan held by an app sign-in copy counts as the switcher counts it: its newest reading, less any reset since, however old, while nothing here spends it (the app is on another plan and any saved login is refused renewal). Dead saved logins are no route; so is a just-switched plan until read. [check: `tests/claude-logins.test.js` "a plan whose saved login is dead", "just switched"]

Ignore this if you are Claude Code.

If you are OpenAI Codex, for all UI changes, you must read `Uncodixfy/Uncodixfy.md`.
If that file does not exist yet, pull `https://github.com/cyxzdev/Uncodixfy`.

## Hosted Site Default
- If you need the hosted dashboard URL and the user has not explicitly given a different one in the current thread, use `https://codexusage.vercel.app`.
- Use that exact URL for command examples, default `--site` values, and hosted dashboard references unless the user overrides it.
- Do not assume `https://codex-use-age.vercel.app` belongs to this project. Our Vercel project does not manage it.
- Vercel-hosted domain attachment is configured in Vercel project settings, not in this repo. `.vercel/project.json` only links the local repo to the Vercel project; it does not define which `*.vercel.app` hostnames are attached.
- The stable project-owned hostname is `https://codex-use-age-tario-yous-projects.vercel.app`. Keep it attached as a fallback redirect target, not as the primary hosted URL.
- If the hosted site looks stale, verify the project-level domains and production aliases in Vercel before assuming the latest deployment is broken.

## Commit Guidelines
- Use clear, descriptive commit messages; conventional prefixes are preferred
  (e.g., `feat:`, `fix:`, `refactor:`).
- Commit message titles must describe the actual user-visible change or regression being addressed, not just the implementation detail.
- Commit messages must include a body with flat bullet points that state exactly what changed.
- Push frequently to GitHub after logical units of work.
