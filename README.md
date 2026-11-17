# NodeSafeRDP

Self-hosted, browser-based remote control for Windows PCs.

```
 Windows PC (normal user)          Rocky Linux 10 VM                    Any browser
 ┌─────────────────────┐   HTTPS   ┌──────────────────────────────┐ HTTPS ┌──────────────┐
 │ NodeSafeRDP agent   │──443────▶ │ nginx (Let's Encrypt TLS)    │◀──────│ login, list, │
 │ outbound only       │           │  └▶ Node.js relay 127.0.0.1  │       │ live viewer  │
 └─────────────────────┘           └──────────────────────────────┘       └──────────────┘
```

* **Agent** – runs as a normal Windows user. No administrator rights, no installer, no code-signing certificate.
* **Server** – one script installs Node.js, nginx, a Let's Encrypt certificate, firewall rules, SELinux settings and a hardened systemd service.
* **Web console** – sign in with a username and password. Sessions last 12 hours and then end, even if you are active. The console lists every machine and whether it is online, and several users can view and control the same machine at once.

## 1. Server (Rocky Linux 10)

Before you start:
* A DNS name (for example `rdp.example.com`) points at the VM.
* Ports 80 and 443 can be reached from the internet. Let's Encrypt needs port 80 for validation and renewals.

```bash
sudo dnf -y install git
git clone <your repo url> nodesaferdp && cd nodesaferdp
sudo bash deploy/install.sh --domain rdp.example.com --email you@example.com --admin admin
```

During the run, the script asks you for the first user's password. When it finishes, it prints the **agent key**.

You can run it again at any time, for example after `git pull`. It updates the code and keeps your config, users and certificate.

| Task | Command |
|---|---|
| Add a user | `sudo nodesaferdp-user add alice` |
| Change a password (signs that user out everywhere) | `sudo nodesaferdp-user passwd alice` |
| Delete a user (their sessions end within a minute) | `sudo nodesaferdp-user del alice` |
| List users | `sudo nodesaferdp-user list` |
| Logs (logins, agents, viewers) | `journalctl -u nodesaferdp -f` |
| Config (agent key, session length) | `/etc/nodesaferdp/config.json`, then `sudo systemctl restart nodesaferdp` |

Certificate renewal runs automatically through a systemd timer, and nginx reloads after each renewal.

## 2. Windows agent (no admin needed)

Copy the `client` folder to the PC. Pick **one** of these two options.

**Option A – build an .exe with the compiler that ships with Windows**

```bat
build.cmd
NodeSafeRDP.exe --setup --server https://rdp.example.com --key <AGENT_KEY>
NodeSafeRDP.exe
```

`build.cmd` uses `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`, which is part of every Windows 10/11 install. The exe is built on the PC itself, so it has no "downloaded from the internet" mark. That means SmartScreen does not ask for a publisher certificate.

**Option B – run from source with PowerShell (no .exe at all)**

```bat
powershell -ExecutionPolicy Bypass -File run.ps1 --setup --server https://rdp.example.com --key <AGENT_KEY>
powershell -ExecutionPolicy Bypass -File run.ps1
```

`-ExecutionPolicy Bypass` applies only to that one process and does not need admin rights.

Options:
* `--setup` saves the settings to `%APPDATA%\NodeSafeRDP\agent.json`. The key is encrypted with Windows DPAPI for that user.
* `--name "Reception PC"` sets the name shown in the console.
* `--transport auto|websocket|poll` picks the connection method.
* `--proxy system|none|http://host:port` sets the proxy.
* `--autostart on` starts the agent at logon, using the current user's `HKCU\...\Run` key.

The console window shows who is viewing the computer at any moment. Close the window to stop remote access.

### Networks with a forced or transparent proxy

The agent only makes **outbound HTTPS connections to port 443**:

1. It tries a **WebSocket** connection first (`wss://…/agent/ws`), which gives the lowest latency.
2. If that fails, or a proxy strips the WebSocket upgrade, it automatically switches to **plain HTTPS long-polling**: normal `GET`/`POST` requests that almost any proxy allows. It tries WebSocket again every 10 minutes.

How it handles proxies:
* **Transparent (iptables-redirected) proxy:** Windows does not know about the proxy and needs no settings. The agent just makes normal HTTPS requests.
* **Proxy that inspects TLS:** the agent trusts the **Windows certificate store**. If IT has installed the proxy's root CA on the PC (they must have, or browsers would fail too), the agent works.
* **Explicit proxy:** the agent uses the Windows system proxy settings, including NTLM/Kerberos sign-in, by default.
* **Very strict proxy:** you can force the polling method with `--transport poll`.

## Limits of running without admin rights

These limits come from Windows itself (UIPI and secure desktops). No program without admin rights can get around them:

* It **cannot control windows of programs running as administrator**. You can see them, but clicks and keys are ignored.
* It **cannot see or use the UAC prompt, the lock screen, or the Ctrl+Alt+Del screen**. While these are showing, the picture pauses.
* It **cannot send Ctrl+Alt+Del**.
* It **only works while the user is signed in** and the agent is running. It cannot start before logon. That would need a Windows service, which requires admin rights.
* Company policy (AppLocker, WDAC, Constrained Language Mode) or antivirus/EDR software may block the agent, as it does with any remote-control tool.

## Security notes (this repository is public)

* **No secrets in the repo.** The installer creates the agent key on the server (`/etc/nodesaferdp/config.json`, readable only by root and the service). Users, password hashes and sessions live in `/var/lib/nodesaferdp`. `.gitignore` excludes local configs and builds.
* **Passwords:** stored as scrypt hashes. Failed logins are rate-limited: 10 per IP and 20 per username every 15 minutes.
* **Sessions:** random 256-bit tokens. The server stores only a SHA-256 of each token. Cookies are `HttpOnly`, `Secure` and `SameSite=Strict`, with a `__Host-` prefix. Sessions end 12 hours after login, and viewers still connected at that point are disconnected.
* **Browser protections:** strict Content-Security-Policy, Origin checks on state-changing requests and on WebSocket connections, and HSTS.
* **The service:** the Node process listens only on `127.0.0.1` and runs as an unprivileged, sandboxed systemd user.
* **The agent key is shared by all agents.** Anyone who has it can register a machine, but **cannot view or control any machine**, because that always needs a web login. If the key leaks, change `agentKey` in the config, restart the service, and run `--setup` on each PC with the new key.
* **Use it only on computers you are authorised to administer.** The agent is deliberately visible to the person at the PC.

## Local development

```bash
cd server && npm ci
cat > config.json <<'EOF'
{ "port": 8080, "agentKey": "dev-key-at-least-24-characters-long", "secureCookies": false, "trustProxy": false }
EOF
NSR_PASSWORD=devpassword1 node cli.js add dev
node src/server.js
# Windows: NodeSafeRDP.exe --config dev.json --setup --server http://127.0.0.1:8080 --key dev-key-at-least-24-characters-long --allow-http
```

## Layout

```
server/src/server.js   HTTP routes, WebSocket upgrade, HTTPS long-poll transport
server/src/hub.js      agents, viewers, tile cache, input relay
server/src/auth.js     users (scrypt), 12 h sessions, rate limiting
server/cli.js          user management
server/public/         login, machine list, viewer (vanilla JS)
client/NodeSafeRDP.cs  Windows agent (C# 5 / .NET Framework 4.x, single file)
client/build.cmd       build with the built-in csc.exe
client/run.ps1         run from source via PowerShell
deploy/install.sh      Rocky Linux 10 installer (nginx + Let's Encrypt + systemd)
```
