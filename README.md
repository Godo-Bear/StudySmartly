# StudySmartly 🎮

A modern game library for games made by me and my friends. Visitors browse, search and filter games, then hit **Play** to open the game's link. Admins add, edit and remove games from the admin panel.

## Pages
- **`index.html`**: the public site. Category chips, search, dark mode, and a game pop-up with a Play button.
- **`admin.html`**: the admin panel. Add a game with its **name, creator, link**, plus an optional category, thumbnail and description. You can also edit or delete games.

All games live in [`data/games.json`](data/games.json) on the **`main`** branch.

## Hosting (Cloudflare Workers)
The site runs on Cloudflare. `wrangler.jsonc` serves the static files, and `src/worker.js` handles the admin API at `/api/*`. Every push to `main` redeploys the site.

## Admin panel
Open `/admin.html` and enter the admin code. The code is checked on Cloudflare's server, so it never appears in the site's files. When an admin saves, the Worker updates `data/games.json` on `main`, and Cloudflare redeploys the site in about a minute.

Add two **secrets** in the Cloudflare dashboard (**Workers & Pages → studysmartly → Settings → Variables and Secrets**):

| Name | Value |
|---|---|
| `ADMIN_CODE` | The code that unlocks the admin panel |
| `GITHUB_TOKEN` | A [fine-grained GitHub token](https://github.com/settings/personal-access-tokens/new) with access to only this repo and **Contents: Read and write** |

To change the admin code, edit the `ADMIN_CODE` secret. Anyone signed in with the old code gets logged out.

## Run locally
1. Create a `.dev.vars` file. It's ignored by git.
   ```
   ADMIN_CODE=yourcode
   GITHUB_TOKEN=github_pat_...
   ```
2. Start the local server:
   ```bash
   npx wrangler dev
   ```
3. Open http://localhost:8787.
