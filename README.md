# StudySmartly 🎮

A modern game library for games made by me and my friends. Visitors browse, search and filter games, then hit **Play** to open the game's link. Admins add, edit and remove games from the admin panel.

## Pages
- **`index.html`**: the home page, with a section for each game type, search and dark mode. The same page also shows one game type (`?category=Shooting`) or one creator's games (`?creator=Name`).
- **`creators.html`**: everyone who has shared games. Click someone to see their games.
- **Sidebar** (on every main page): Home, each game type with its count, Creators and Add your game. On computers it's a slim strip of icons that slides open when you hover over it. On phones it opens from the ☰ button.
- **🔥 Most Played** (top of the home page): the most played games, ranked. Plays are counted when someone presses Play, once per visitor per game every 30 minutes. A Durable Object (`PlayCounter`, SQLite-backed, on the free plan) does the counting.

**App icon:** the `icons/` folder holds the home-screen icon (iPhone `apple-touch-icon.png`, plus Android/Chrome sizes). `manifest.webmanifest` makes "Add to Home Screen" open StudySmartly like an app. To change the icon, edit `icons/icon-source.svg` and re-export the PNGs.

**Live site:** https://studysmartly.jn-studios.workers.dev
- **`play.html`**: plays the game inside StudySmartly, with Fullscreen and Share buttons and more games underneath.
- **`admin.html`**: the admin panel. Add a game with its **name, creator, link and a thumbnail picture**, plus an optional category and description. You can also edit or delete games.

Thumbnails can be any picture or a PDF (its first page is used). They're shrunk to 512px in the browser and saved in `images/`.

## Creators add their own games
Anyone with an account can click the round **＋ Add your game** button in the bottom-right corner. It opens `create.html`, where creators publish a game themselves, with no admin needed. There are two ways:
- **Link:** a game that's already online.
- **Upload files:** a `.zip` of the game folder, a single `.html` file, or a whole folder.

Uploaded files are stored in Cloudflare KV and served from `/games/<folder>/...`. They're served with a CSP `sandbox` header, so the game runs as a separate origin and can't read StudySmartly logins. Because of the sandbox, games can't use the browser's own `localStorage`, so they get a stand-in:
- **Logged in:** progress is saved to the player's account in KV (`save:<user>:<folder>`, up to 512 KB per game) and loaded back before the game starts, on any device. The play page gets a 10-minute "save ticket" that only unlocks that one player's save for that one game. It saves every ~15 seconds while playing, and right away when the player leaves. Players can also **Reset progress**.
- **Logged out:** the game still runs, but a banner says progress won't be saved and asks them to log in or make an account.

The limits are 200 files, 20 MB per file, 40 MB per game and 25 games per creator. On the free plan, KV allows about 1,000 file writes a day.

Under **My games**, creators can edit or delete their own games, and they can always play their own paid games. Admins can still edit or delete any game.

## Paid games
Tick **"Needs to pay owner to own"** when adding a game. You can also add a price, such as "$2".

How a player gets a paid game:
1. The player makes an account with the **Log in** button.
2. They pay the game's owner however you like, such as cash or PayPal, and tell the owner their username.
3. The game's creator opens **My games → 🔓 Unlock** on the Create page, types the buyer's username and picks how they paid. They can also see who owns the game, and lock it again. Or an admin opens **Player accounts → Unlock a paid game** in the admin panel. They pick the account and the game, choose how it was paid (Cash, for example), and click Unlock. The panel records who unlocked it, when, and the payment method.

## Site lock: the owner allows every account
- People need an account the owner has allowed to use the site. Without one, every page shows a "StudySmartly" screen explaining that the owner checks each account to keep the site safe.
- New accounts start on **FALSE**. In the admin panel, **🛡️ Who can get on** lists every username. Click **FALSE** to set it to **TRUE** and let them on, and click TRUE to take access away again. Accounts made before the lock existed, and admins, are TRUE.
- **👀 Login attempts** shows everyone who logged in or signed up, and failed tries, for the last 30 days: when, username, what happened, rough location and device.
- The server enforces the lock: the game list (`/api/games`), games, saves and Create tools refuse anyone who isn't allowed, and `/data/games.json` isn't public.

## More admin tools
- **Creator accounts:** only creators (and admins) can add games or upload new versions. In **Who can get on**, the **Creator** column sets each account to *forever*, *1 / 7 / 30 / 90 days* (it switches off by itself), or *not a creator*. People keep the games they've already added.
- **🔑 Reset password** makes a temporary password like `storm-comet-933`. They must choose their own the next time they log in, and the reset logs them out everywhere. Everyone can also use **Change password** in their account menu.
- **Login lockout:** 10 wrong passwords in a row lock that username for 15 minutes. A password reset clears it.
- **🚩 Reports:** games players reported as broken or inappropriate. Check them, then mark them done.

## For players
- **👍 / 👎** on every game, and a **Top Rated** section on the home page.
- **⭐ Favourite** button, plus **Recently Played** and **Your Favourites** at the top of the home page, saved to their account.
- **🚩 Report** button for broken or inappropriate games.

## 👤 Player profiles
`profile.html?u=<username>` shows:
- the player's badges (Admin, Creator), join date and when they were last on,
- stats: games made, games revised, likes given and comments,
- the games they made and their favourites,
- an **Add friend**, **Accept** or **💬 Message** button.

Names in comments and chat link to profiles, and **👤 My profile** is in the account menu.

## Games appear straight away
After a change, the Worker keeps the new game list, and any new thumbnail, in KV for 15 minutes. That's `games-latest` and `img:<path>`. The site uses them until Cloudflare's rebuild of `data/games.json` and `images/` has finished.

## 💬 Friends & Chat
`chat.html` opens from the sidebar link above the game types, which has a red badge for unread messages and friend requests.
- **Friends:** add people by username. They accept or decline the request.
- **Direct messages:** chat with any friend.
- **Group chats:** each group gets a room code like `K7M-4QX`, shown at the top of the group with a Copy button. Anyone allowed onto the site can join with the code, up to 50 people per group.
- **Live:** messages arrive instantly over a WebSocket to the `ChatHub` Durable Object (SQLite). Each player connects with a one-minute ticket.
- **Safety:**
  - Only allowed (TRUE) accounts can chat.
  - **Block** stops someone's friend requests and messages.
  - **Report** sends a message to **💬 Reported messages** in the admin panel. Admins can delete it there, and it disappears for everyone straight away.
  - Sending is limited to 8 messages per 10 seconds.
  - Deleting an account removes it from all chats.

## ✨ AI overview
Under **About this game**, Cloudflare's free Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`, the `AI` binding) reads the game and explains it: summary, goal, how to play, controls, tips and what it's good for.
- **Uploaded games:** it reads the text files from KV.
- **Link games:** it fetches the page and its scripts from the same site.
- **Big files:** files over 40k characters, usually libraries, are skipped and listed for the AI.
- **Saved once:** each overview is written once per game version, saved in KV (`ai:<gameId>:v<version>`), and served from there.
- **Refresh:** the game's creator or an admin can write it again with **Refresh**.
- **Free limit:** the free plan has a daily limit. If it runs out, the box says to try again tomorrow.

## Updating games
- **Link games** update by themselves. StudySmartly shows the creator's own site, so changes there show here straight away.
- **Uploaded games:** in **My games → Edit**, creators upload a new version. Plays, likes and everyone's saved progress stay, because saves belong to the game, not its files.

## Admin accounts
Anyone can make an account on `login.html`. In the admin panel, click **Make admin** next to an account.

Admin accounts open the admin panel without the code, by logging in normally, and can play every paid game. The `ADMIN_CODE` still works as a backup. Admins can't remove their own admin status or delete their own account.

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
