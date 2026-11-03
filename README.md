# StudySmartly 🎮

A modern game library for games made by me and my friends. Visitors browse, search and filter games, then hit **Play** to open the game's link. Admins add, edit and remove games from the admin panel.

## Pages
- **`index.html`**: the public site. Category chips, search, dark mode, and a game pop-up with a Play button.
- **`admin.html`**: the admin panel. Add a game with its **name, creator, link**, plus an optional category, thumbnail and description. You can also edit or delete games.

All games live in [`data/games.json`](data/games.json) on the **`main`** branch.

## Going live (GitHub Pages)
1. On GitHub, open **Settings → Pages**.
2. Under **Source**, pick **Deploy from a branch**, then choose **`main`** and **`/ (root)`**.
3. Your site will be at `https://<your-username>.github.io/StudySmartly/`.

## How the admin panel works
The admin panel has no server. It saves games by committing `data/games.json` straight to the `main` branch through the GitHub API, so **only people with write access to this repo can change games**.

To sign in as an admin:
1. Create a [fine-grained token](https://github.com/settings/personal-access-tokens/new).
2. Set **Repository access** to only this repo.
3. Set **Permissions → Contents** to **Read and write**.
4. Open `admin.html` and paste the token in.

The token is stored only in your browser.

To add another admin, invite them as a collaborator on the repo (**Settings → Collaborators**). They then make their own token.

After you save, GitHub Pages rebuilds and the change shows up on the site in about a minute.

## Run locally
```bash
python3 -m http.server 8000
```
Then open http://localhost:8000.
