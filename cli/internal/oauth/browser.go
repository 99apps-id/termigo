package oauth

import (
	"os/exec"
	"runtime"
)

// openBrowser opens a login URL in the default browser. A failure is ignored:
// the caller has printed the URL, so the operator can open it by hand.
func openBrowser(link string) {
	var command *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		// `cmd /c start "" <url>` handles commas and spaces in the URL, which
		// rundll32's nonstandard argument parsing splits.
		command = exec.Command("cmd", "/c", "start", "", link)
	case "darwin":
		command = exec.Command("open", link)
	default:
		command = exec.Command("xdg-open", link)
	}
	_ = command.Start()
}
