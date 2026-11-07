# termigo-shell-integration (PowerShell)
# Emits OSC 7 (cwd) + OSC 133 A/B/C/D so the host tracks cwd and prompt
# boundaries. C comes from a PSConsoleHostReadLine wrapper (PowerShell has no
# preexec hook).

if ($global:__TERMIGO_HOOKS_LOADED) { return }
$global:__TERMIGO_HOOKS_LOADED = $true

# The host launches us with `-File`, which SKIPS $PROFILE entirely. Without
# dot-sourcing it, a user's aliases, modules, conda/posh-git init and PATH
# tweaks were silently absent while their own PowerShell windows had them, and
# the "wrap the user's prompt" logic below could only ever see the default.
# Set first so a profile that re-invokes this file cannot recurse.
try {
    $__termigo_user_profile = $PROFILE.AllUsers.AllHosts, $PROFILE.AllUsers.CurrentUser,
        $PROFILE.CurrentUser.CurrentHost, $PROFILE.CurrentUser.AllHosts | Where-Object {
            $_ -and (Test-Path -LiteralPath $_ -PathType Leaf)
        } | Select-Object -First 1
    if ($__termigo_user_profile) { . $__termigo_user_profile }
} catch {
    # A broken user profile must not cost the user their shell.
}

if ($env:TERMIGO_CLI -and (Test-Path -LiteralPath $env:TERMIGO_CLI -PathType Leaf)) {
    function global:termigo {
        & $env:TERMIGO_CLI @args
    }
}

try {
    [Console]::InputEncoding  = [System.Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $global:OutputEncoding    = [System.Text.UTF8Encoding]::new($false)
} catch {}

# Capture whatever prompt is in effect NOW -- after the user's $PROFILE has
# run and possibly replaced the default one. Capturing before that point
# wrapped the stock `PS C:\>` and dropped starship/posh-git prompts.
if (Test-Path Function:prompt) {
    Copy-Item Function:prompt Function:__termigo_user_prompt -Force -ErrorAction SilentlyContinue
}

function global:__termigo_urlencode {
    param([string]$s)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($s)
    $sb = [System.Text.StringBuilder]::new($bytes.Length)
    foreach ($b in $bytes) {
        if (($b -ge 0x30 -and $b -le 0x39) -or
            ($b -ge 0x41 -and $b -le 0x5A) -or
            ($b -ge 0x61 -and $b -le 0x7A) -or
            $b -eq 0x2F -or $b -eq 0x2E -or $b -eq 0x5F -or
            $b -eq 0x7E -or $b -eq 0x2D) {
            [void]$sb.Append([char]$b)
        } else {
            [void]$sb.AppendFormat('%{0:X2}', $b)
        }
    }
    $sb.ToString()
}

# Wrap PSConsoleHostReadLine (defined by PSReadLine) to emit OSC 133 C with
# the accepted command line just before execution. Installed lazily from
# prompt: PSReadLine may finish loading only after this profile has run.
function global:__termigo_install_readline {
    if ($global:__termigo_readline_done) { return }
    if (-not (Test-Path Function:PSConsoleHostReadLine)) { return }
    $global:__termigo_readline_done = $true
    # global: is required -- a plain Function: copy made inside a function
    # lands in its local scope and vanishes when it returns, leaving the
    # wrapper calling a missing command on every read (empty-input loop).
    Copy-Item Function:PSConsoleHostReadLine Function:global:__termigo_user_readline -Force
    function global:PSConsoleHostReadLine {
        try {
            $line = __termigo_user_readline
        } catch {
            # Self-heal: restore the original reader so a broken wrapper can
            # never lock the shell out of input.
            Copy-Item Function:__termigo_user_readline Function:global:PSConsoleHostReadLine -Force
            return ''
        }
        try {
            if ($line -is [string] -and $line.Trim().Length -gt 0) {
                $global:__termigo_block_seen = $true
                $esc = [char]27
                $cmd = $line -replace '[\x00-\x1F\x7F]', ' '
                if ($cmd.Length -gt 256) { $cmd = $cmd.Substring(0, 256) }
                [Console]::Write("$esc]133;C;$cmd$esc\")
            }
        } catch {}
        $line
    }
}

function global:prompt {
    __termigo_install_readline
    $lec = $LASTEXITCODE
    if ($null -eq $lec) { $lec = if ($?) { 0 } else { 1 } }
    $esc = [char]27

    $oscD = "$esc]133;D;$lec$esc\"
    $oscA = "$esc]133;A$esc\"
    $oscB = "$esc]133;B$esc\"

    $loc = Get-Location
    $osc7 = ''
    if ($loc.Provider.Name -eq 'FileSystem') {
        $cwd = $loc.ProviderPath -replace '\\','/'
        if ($cwd -match '^[A-Za-z]:') { $cwd = "/$cwd" }
        # UNC (\\server\share\dir -> //server/share/dir) keeps its server
        # component. Stripping it produced //share/dir, a host that does not
        # exist, so the status bar and the file tree both failed to open it.
        # parseOsc7 discards the file:// host anyway, so the server can only
        # survive inside the path component.
        $cwdEnc = __termigo_urlencode $cwd
        $hostName = [System.Environment]::MachineName
        $osc7 = "$esc]7;file://$hostName$cwdEnc$esc\"
    }

    # Block mode: the host renders its own input bar, so suppress the shell
    # prompt (markers only) and reserve the header/gap rows in the prompt
    # itself -- same layout contract as the zsh integration.
    if ($env:TERMIGO_BLOCKS) {
        $global:LASTEXITCODE = $lec
        $gap = if ($global:__termigo_block_seen) { "`n`n" } else { "`n" }
        return "$oscD$oscA$osc7$gap$oscB"
    }

    $original = if (Test-Path Function:__termigo_user_prompt) {
        try { & __termigo_user_prompt } catch { "PS $((Get-Location).Path)> " }
    } else {
        "PS $((Get-Location).Path)> "
    }

    $global:LASTEXITCODE = $lec
    try {
        # Emit zero-width OSC markers and prompt directly via Console::Write so
        # PSReadLine does not include invisible escape codes in its prompt-width
        # calculation (which otherwise causes line-wrapping, orphan characters,
        # and cursor offsets on resize/prompt redraw).
        [Console]::Write("$oscD$oscA$osc7$original$oscB")
        return ""
    } catch {
        return "$oscD$oscA$osc7${original}${oscB}"
    }
}
