# termigo

Install or start the [Termigo](https://github.com/99apps-id/termigo) desktop app
from the terminal.

```bash
npx termigo          # install for this machine, then start it
npm i -g termigo     # then just: termigo
```

There are no dependencies, and nothing has to be compiled: the command
downloads the build that was made for your machine, checks it against the
checksum GitHub publishes for that file, installs it, and starts it.

## Why this is not `npm install github:99apps-id/termigo`

Termigo is a Tauri application, not a library. Installing the repository as a
dependency only reproduces a source tree that then needs a Rust toolchain and
about twelve minutes to compile — and it gives you no command to run
afterwards, because the package declares no `bin`. This package is an installer
instead, and the second thing it does is make itself unnecessary: once the app
is installed, running `termigo` again just opens it.

## Options

| Option | Effect |
| --- | --- |
| `--dry-run` | Show the file, its size, its checksum and how it would install. Downloads nothing. |
| `--list` | List every file in the current release, with `*` on the one for this machine. |
| `--reinstall` | Install again even if the app is already present. |
| `--app-version <x.y.z>` | Install a specific release instead of the newest. |
| `--format <name>` | Pick a different artifact (see below). |
| `--dir <path>` | Download here instead of a temporary directory. |
| `--keep` | Keep the downloaded file. |
| `--silent` | Install without a progress window (Windows only). |
| `--no-verify` | Install without checking the checksum. |
| `--no-launch` | Install without starting the app. |
| `--no-cli` | Do not install the terminal companion. |
| `--platform`, `--arch` | Override detection, for `--dry-run` on another machine. |

### Formats

| Platform | Formats | Default |
| --- | --- | --- |
| Windows | `msi`, `nsis` | `msi` |
| macOS | `dmg` | `dmg` |
| Linux | `appimage`, `deb`, `rpm` | `appimage` |

The default is the one that asks least of you. An AppImage installs into
`~/.local/share/termigo` with no root at all; a `deb` or an `rpm` is handed to
your package manager so it can be upgraded and removed normally, which is why it
is a choice rather than the default.

## On a server without a display

Installing is safe on a headless VPS; nothing here needs a window to run. Two
things are worth knowing before you do it.

**It will not start the app, and it will say so.** Termigo is a Tauri
application, so launching it with no display fails immediately and silently —
which is why the missing display is detected and the install stops there instead
of spawning a process that dies without a word. You get the exact command that
does work on a server:

```
  not started: no display on this machine (a server, or an SSH session without X).

  Termigo is a desktop app, but it runs headless too - the repository's
  scripts/run-headless.sh is the supported entry point, and this is what it runs:

    xvfb-run -a -s '-screen 0 1024x768x24' dbus-run-session ~/.local/share/termigo/Termigo_<v>_amd64.AppImage

  Do not run the binary directly without xvfb-run: WebKit looks for a D-Bus
  session and exits. See docs/headless-vps.md.
```

The D-Bus session is the part people leave out: WebKit starts, then dies on the
bus lookup.

**Prefer `--format deb` on a server.** The AppImage is the default because it
needs no root, but on a server the deb is the better tool: it installs
`/usr/bin/termigo`, records the package for upgrades and removal, and declares
`libwebkit2gtk-4.1-0` and `libgtk-3-0` as dependencies so your package manager
installs them. The AppImage declares none of that, and neither format brings
`xvfb` or `dbus` — those are the wrapper's job.

```bash
npx termigo --format deb --no-launch
```

> **Never install a release beside a Termigo that is already running.** There is
> no single-instance guard, and both would use the same data directory
> (`~/.local/share/id.99apps.termigo/`) and long-poll the same Telegram token.
> That is not an upgrade; it is two agents sharing one session store.

## The terminal companion

`termigo` also installs **`termigo-go`**, the Go command-line companion, which is
where the interactive terminal lives:

```bash
termigo-go tui        # setup, models, settings, approval, live status
termigo-go status     # and the same actions non-interactively:
termigo-go models
termigo-go settings set defaultModelId claude-sonnet-4-6
termigo-go approval
termigo-go secret anthropic
```

Press `q` to leave the TUI. Every one of those commands drives a **running**
Termigo app over its local control socket (`~/.cache/termigo/control.json` on
Linux and macOS, `%LOCALAPPDATA%\termigo\control.json` on Windows), so start the
app first - without it they answer `Termigo is not running`.

It is deliberately not called `termigo`: that name is this installer, and a
second binary with the same name would shadow one or the other depending on
`PATH` order. It is installed to `~/.local/bin` on Linux and macOS and to
`%LOCALAPPDATA%\Programs\termigo-cli` on Windows; if that directory is not on
`PATH` the command says so, because an installed command that cannot be found by
name looks exactly like a failed install.

The companion is downloaded separately rather than bundled inside the app, and
that is a constraint rather than a preference: a Tauri sidecar has to exist for
every build of the application, and the server that builds the headless binary
has no Go toolchain. A companion only some builders can produce cannot be a
build dependency of all of them. It is also **never fatal** - if a release does
not carry it, the app still installs and the reason is printed.

## Checksums

The checksum is read from the `digest` field GitHub publishes for every release
asset, and a download that does not match is deleted without being installed. If
a release publishes no digest, the command **refuses to install** unless you pass
`--no-verify` — the step where a hijacked DNS answer turns into an installed
application is not one to be relaxed by default.

## Where it installs

The app is deliberately never put on `PATH`, because `termigo` is already this
command and a second binary with the same name would shadow one or the other
depending on `PATH` order.

| Platform | Location |
| --- | --- |
| Linux (AppImage) | `~/.local/share/termigo/Termigo_<version>_amd64.AppImage` |
| Linux (deb/rpm) | installed system-wide by `dpkg` / `dnf` |
| macOS | `/Applications/Termigo.app` |
| Windows | installed by Windows Installer |

## Publishing

Releases are built by the repository's own workflow; this package only reads
them. Publish it from this directory so the version stays in step with the app:

```bash
cd npm/termigo
cp ../../LICENSE LICENSE   # keep the license text in step with the root copy
npm test
npm publish
```

The version in `package.json` is this installer's own version and can run ahead
of the app: the download resolves the newest *release* rather than this file's
version, so the two drift safely. 0.9.15 is a patch on top of 0.9.14, which was
published with a syntax error in `bin/termigo.mjs` and never ran.
