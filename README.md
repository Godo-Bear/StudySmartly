# StudySmartly 🎮

A modern game library for games made by me and my friends. Visitors browse, search and filter games, then hit **Play** to open the game's link. Admins add, edit and remove games from the admin panel.

## Pages
- **`index.html`**: the home page, with category chips, search and dark mode. Clicking a game opens its play page.
- **`play.html`**: plays the game inside StudySmartly, with Fullscreen and Share buttons and more games underneath.
- **`admin.html`**: the admin panel. Add a game with its **name, creator, link and a thumbnail picture**, plus an optional category and description. You can also edit or delete games.

Thumbnails can be any picture or a PDF (its first page is used). They're shrunk to 512px in the browser and saved in `images/`.

## Paid games
Tick **"Needs to pay owner to own"** when adding a game. You can also add a price, such as "$2".

How a player gets a paid game:
1. The player makes an account with the **Log in** button.
2. They pay the game's owner however you like, such as cash or PayPal, and tell the owner their username.
3. An admin unlocks the game for that username under **Player accounts** in the admin panel.

Paid games' links are never put in the public `games.json`. The Worker only gives the link to accounts the game is unlocked for.

Accounts, logins, unlocks and paid-game links are stored in Cloudflare KV (the `DB` binding). Cloudflare creates this storage automatically on deploy.

All games live in [`data/games.json`](data/games.json) on the **`main`** branch.

## Hosting (Cloudflare Workers)
`/api/admin/*` is the admin API, which needs the admin code. `/api/auth/*`, `/api/me` and `/api/play/:id` handle player accounts.

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
