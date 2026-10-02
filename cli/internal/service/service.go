// Package service registers the Termigo Telegram assistant with the operating
// system so it runs 24/7 on a headless server: a systemd user unit on Linux
// (with lingering, so it survives logout and starts at boot), a launchd agent
// on macOS and a logon scheduled task on Windows. It runs the Go CLI, so it
// carries no webview and stays light.
package service

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

const (
	serviceTaskName = "TermigoAssistant"
	launchdLabel    = "com.termigo.assistant"
	systemdService  = "termigo.service"
)

// Install registers the auto-start entry for the current binary.
func Install(stdout io.Writer) error {
	binary, err := os.Executable()
	if err != nil {
		return fmt.Errorf("cannot resolve binary path: %v", err)
	}
	switch runtime.GOOS {
	case "windows":
		return installWindows(stdout, binary)
	case "darwin":
		return installDarwin(stdout, binary)
	case "linux":
		return installLinux(stdout, binary)
	default:
		return fmt.Errorf("auto-start is not supported on %s", runtime.GOOS)
	}
}

// Uninstall removes the auto-start entry.
func Uninstall(stdout io.Writer) error {
	switch runtime.GOOS {
	case "windows":
		return uninstallWindows(stdout)
	case "darwin":
		return uninstallDarwin(stdout)
	case "linux":
		return uninstallLinux(stdout)
	default:
		return fmt.Errorf("auto-start is not supported on %s", runtime.GOOS)
	}
}

// Status prints the auto-start state.
func Status(stdout io.Writer) error {
	switch runtime.GOOS {
	case "windows":
		return statusWindows(stdout)
	case "darwin":
		return statusDarwin(stdout)
	case "linux":
		return statusLinux(stdout)
	default:
		return fmt.Errorf("auto-start is not supported on %s", runtime.GOOS)
	}
}

func installWindows(stdout io.Writer, binary string) error {
	command := fmt.Sprintf(`"%s" telegram`, binary)
	cmd := exec.Command("schtasks.exe", "/Create", "/TN", serviceTaskName, "/TR", command, "/SC", "ONLOGON", "/F")
	cmd.Stdout = stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("install failed: %v", err)
	}
	_ = exec.Command("schtasks.exe", "/Run", "/TN", serviceTaskName).Run()
	fmt.Fprintf(stdout, "Service installed and started. It will run 24/7 and start at logon.\n")
	return nil
}

func uninstallWindows(stdout io.Writer) error {
	_ = exec.Command("schtasks.exe", "/End", "/TN", serviceTaskName).Run()
	cmd := exec.Command("schtasks.exe", "/Delete", "/TN", serviceTaskName, "/F")
	cmd.Stdout = stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("uninstall failed: %v", err)
	}
	fmt.Fprintf(stdout, "Service uninstalled.\n")
	return nil
}

func statusWindows(stdout io.Writer) error {
	output, err := exec.Command("schtasks.exe", "/Query", "/TN", serviceTaskName, "/FO", "LIST", "/V").CombinedOutput()
	if err != nil {
		// A query for a missing task is the normal "not installed" answer, and
		// the message is localized, so any failure here reports that state.
		fmt.Fprintf(stdout, "Service is not installed.\n")
		return nil
	}
	fmt.Fprintf(stdout, "%s", output)
	return nil
}

func installDarwin(stdout io.Writer, binary string) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("cannot resolve home: %v", err)
	}
	agentDir := filepath.Join(home, "Library", "LaunchAgents")
	if err := os.MkdirAll(agentDir, 0o755); err != nil {
		return fmt.Errorf("cannot create LaunchAgents dir: %v", err)
	}
	plistPath := filepath.Join(agentDir, launchdLabel+".plist")
	plist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>%s</string>
	<key>ProgramArguments</key>
	<array>
		<string>%s</string>
		<string>telegram</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>/tmp/termigo-stdout.log</string>
	<key>StandardErrorPath</key>
	<string>/tmp/termigo-stderr.log</string>
</dict>
</plist>`, launchdLabel, binary)
	if err := os.WriteFile(plistPath, []byte(plist), 0o644); err != nil {
		return fmt.Errorf("cannot write plist: %v", err)
	}
	cmd := exec.Command("launchctl", "load", plistPath)
	cmd.Stdout = stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("launchctl load failed: %v", err)
	}
	fmt.Fprintf(stdout, "Service installed. It will start automatically at login.\n")
	return nil
}

func uninstallDarwin(stdout io.Writer) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	plistPath := filepath.Join(home, "Library", "LaunchAgents", launchdLabel+".plist")
	_ = exec.Command("launchctl", "unload", plistPath).Run()
	_ = os.Remove(plistPath)
	fmt.Fprintf(stdout, "Service uninstalled.\n")
	return nil
}

func statusDarwin(stdout io.Writer) error {
	output, err := exec.Command("launchctl", "list").CombinedOutput()
	if err != nil {
		return fmt.Errorf("launchctl list failed: %v\n%s", err, strings.TrimSpace(string(output)))
	}
	if strings.Contains(string(output), launchdLabel) {
		fmt.Fprintf(stdout, "Service is installed and loaded.\n")
	} else {
		fmt.Fprintf(stdout, "Service is not loaded.\n")
	}
	return nil
}

func installLinux(stdout io.Writer, binary string) error {
	systemDir, err := systemdUserDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(systemDir, 0o755); err != nil {
		return fmt.Errorf("cannot create systemd user dir: %v", err)
	}
	servicePath := filepath.Join(systemDir, systemdService)
	unit := fmt.Sprintf(`[Unit]
Description=Termigo Telegram assistant
After=network.target

[Service]
Type=simple
ExecStart=%s telegram
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`, binary)
	if err := os.WriteFile(servicePath, []byte(unit), 0o644); err != nil {
		return fmt.Errorf("cannot write service file: %v", err)
	}
	for _, args := range [][]string{
		{"systemctl", "--user", "daemon-reload"},
		{"systemctl", "--user", "enable", "--now", systemdService},
	} {
		cmd := exec.Command(args[0], args[1:]...)
		cmd.Stdout = stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("%s failed: %v", strings.Join(args, " "), err)
		}
	}
	// Lingering keeps the user service running after SSH closes and starts it
	// at boot without a login.
	_ = exec.Command("loginctl", "enable-linger").Run()
	fmt.Fprintf(stdout, "Service installed. Termigo will run 24/7 as a background service.\n")
	return nil
}

func uninstallLinux(stdout io.Writer) error {
	systemDir, err := systemdUserDir()
	if err != nil {
		return err
	}
	servicePath := filepath.Join(systemDir, systemdService)
	_ = exec.Command("systemctl", "--user", "disable", "--now", systemdService).Run()
	_ = os.Remove(servicePath)
	_ = exec.Command("systemctl", "--user", "daemon-reload").Run()
	fmt.Fprintf(stdout, "Service uninstalled.\n")
	return nil
}

func statusLinux(stdout io.Writer) error {
	output, err := exec.Command("systemctl", "--user", "status", systemdService, "--no-pager").CombinedOutput()
	if err != nil {
		if strings.Contains(string(output), "could not be found") {
			fmt.Fprintf(stdout, "Service is not installed.\n")
			return nil
		}
		return fmt.Errorf("status check failed: %v\n%s", err, strings.TrimSpace(string(output)))
	}
	fmt.Fprintf(stdout, "%s", output)
	return nil
}

func systemdUserDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "systemd", "user"), nil
}
