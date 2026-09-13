# Deploying Piecework

Two supported homes. **The Ubuntu box** (`deploy/vps/`) runs the marketplace itself behind nginx
with a Let's Encrypt certificate; that is where the public URL lives. **A Mac** (`deploy/*.plist`)
runs the Git Master pass under your Claude Max subscription and can also run the server for
local use. The two combine: the Mac's pass points at the box with `PIECEWORK_URL` in `.env`.

## The Ubuntu box

```bash
curl -fsSL https://raw.githubusercontent.com/lbesecker195/piecework/main/deploy/vps/install.sh \
  | sudo bash -s -- --domain piecework.example.com --email you@example.com
```

Re-run `sudo bash /var/www/HoneyTrap/piecework/deploy/vps/install.sh --yes` to redeploy. Keys are
in `/etc/piecework.env`; the service is `piecework`; nginx site `piecework`. Live mode by default.

# Running the Git Master (and optionally the server) on a Mac

The mini runs two things forever: the Piecework server, and a scheduled pass of the Git Master
(Claude Code, under your Max subscription). Both are `launchd` user agents, so the machine must
stay logged in as you.

## 1. The machine, once

- **System Settings → Users & Groups → Automatic login: on.** Claude Code and `gh` read your
  login keychain; it is unlocked by logging in.
- **Never sleep.** System Settings → Energy: turn off "Put hard disks to sleep", enable "Wake for
  network access", and set the display to sleep but not the computer. Or in Terminal:
  `sudo pmset -a sleep 0 disksleep 0`.
- **Screen lock** can stay on; it does not lock the keychain.
- Install Homebrew, then: `brew install node gh cloudflared` and Claude Code per the docs.
- `gh auth login` (the Git Master reads pull requests with it) and `claude` once interactively to
  sign in with the Max account.

## 2. The repo

```bash
git clone https://github.com/lbesecker195/piecework ~/piecework && cd ~/piecework
npm ci --omit=dev
cp .env.example .env     # then edit: PIECEWORK_MODE=live, BASE_URL=https://your.domain, keys below
```

Put the two admin keys in `.env` so they survive reinstalls:

```bash
echo "GIT_MASTER_KEY=pwgm_$(openssl rand -hex 24)" >> .env
echo "OWNER_KEY=pwown_$(openssl rand -hex 24)" >> .env
```

## 3. Public URL

The marketplace has to be reachable from the internet. The free, no-port-forwarding way is a
Cloudflare Tunnel on a domain you own:

```bash
cloudflared tunnel login
cloudflared tunnel create piecework
cloudflared tunnel route dns piecework piecework.yourdomain.com
cloudflared tunnel run --url http://localhost:4020 piecework      # then: cloudflared service install
```

Set `BASE_URL=https://piecework.yourdomain.com` in `.env`. Tailscale Funnel works too.

## 4. Install the agents

```bash
deploy/install.sh              # server + Git Master pass every 10 minutes
deploy/install.sh --interval 300
deploy/install.sh --remove
```

`deploy/install.sh --dry-run` renders and lints the plists without installing anything.

## 5. What the pass does

`deploy/ops-pass.sh` runs on the interval. It asks the server how many items the Git Master can
act on (`npm run ops -- pending`). If the answer is 0 it logs "quiet" and exits without starting
Claude Code, so an idle night costs nothing against the plan. Otherwise it runs
`claude -p` with `deploy/ops-prompt.md`, restricted to the read-only GitHub commands and the ops
console, and appends the transcript to `data/logs/ops-YYYY-MM-DD.log`.

The pass can judge, approve projects and queue payments. It cannot approve a payment; that is the
Owner key, at `/admin`, from your phone if you like.

## 6. Check on it

```bash
launchctl list | grep piecework
tail -f ~/piecework/data/logs/server.log ~/piecework/data/logs/ops.log
npm run ops -- status
```

Updating: `git pull && npm ci --omit=dev && launchctl kickstart -k gui/$UID/com.piecework.server`.
