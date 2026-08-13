# SSH & remote files

Termigo connects to remote hosts over SSH directly from the terminal:
no separate app, no config file to hand-edit. The remote shell runs as a
normal terminal tab, so splits, inline search, and the AI agent's context
bridge all keep working.

## Connecting

1. Click the **server icon** in the top toolbar (left of the tab bar).
2. **Add a connection**: host, port, user, and one of three auth methods:
   - **ssh-agent**: the local agent signs the handshake; the private key
     never leaves the agent
   - **Private key**: PEM text (OpenSSH or PKCS8), optional passphrase
   - **Password**
3. Optional **ProxyJump**: pick another saved connection as a jump host, so
   the connection dials through it (chains are supported).
4. **Test** verifies the handshake before you save. **Connect** opens the
   remote shell as a new terminal tab.

Secrets (password, key, passphrase) are stored in the OS keychain, never in
the connection store on disk.

## Host-key verification (TOFU)

The first time you connect to a host, Termigo shows its `SHA256:` fingerprint
and **pauses the handshake before sending any credentials**. Verify the
fingerprint out-of-band (ask the admin, or run
`ssh-keygen -lf <hostkey>` on the server), then accept to pin it on the saved
connection. A later connect that sees a different key **aborts with a
"host key mismatch" error**, so a silent MITM cannot re-anchor the key.

## Remote files (SFTP)

While an SSH session is connected, open the SSH menu and pick
**Browse remote files (user@host)**. A right panel opens showing the remote
tree:

- **Navigate**: click folders; breadcrumbs at the top; refresh button
- **Create / rename / delete** via the context menu (right-click)
- **Upload**: drag files from the local explorer onto a remote folder
- **Download**: context menu on a file
- The tree reuses the same renderer as the local explorer, including icons
  and the inline rename input

All operations run as the remote SSH user; the remote kernel enforces
permissions and `permission denied` bubbles up in-tree.

## Port forwarding

Open the connection, then in the terminal:

```text
(no separate command; forwards are declared per connection)
```

Port forwarding (`-L` style: bind `127.0.0.1:local` and tunnel to
`remote:port` through the session) is exposed through the backend
(`ssh_forward_open`) and is opened for declared forwards on connect.

## Session lifecycle

- SSH tabs behave like terminal tabs: close to disconnect, split to get a
  second remote shell on the same session.
- The active SSH session powers the SFTP explorer (last connected wins).
- If the remote disconnects, the tab shows the exit and the session is
  cleaned up; reconnect from the SSH menu.

## Backend notes

- `russh` drives the handshake; one shared Tokio runtime serves all sessions.
- Host-key algorithms are pinned to the vetted set (ed25519, ecdsa NIST P-256
  / P-384 / P-521, rsa-sha2). Bare `ssh-rsa` (SHA-1 signatures) is refused.
- SSH sessions are independent of the local PTY daemon, so they survive
  workspace switches.
