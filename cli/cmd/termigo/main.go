package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"runtime"

	"github.com/99apps-id/termigo/cli/internal/doctor"
)

var version = "dev"

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "termigo:", err)
		os.Exit(1)
	}
}

func run(args []string, stdout io.Writer) error {
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		writeUsage(stdout)
		return nil
	}

	switch args[0] {
	case "version", "--version", "-v":
		_, err := fmt.Fprintf(stdout, "termigo %s (%s/%s)\n", version, runtime.GOOS, runtime.GOARCH)
		return err
	case "doctor":
		return runDoctor(args[1:], stdout)
	default:
		return fmt.Errorf("unknown command %q; run 'termigo help'", args[0])
	}
}

func runDoctor(args []string, stdout io.Writer) error {
	jsonOutput := false
	for _, arg := range args {
		switch arg {
		case "--json":
			jsonOutput = true
		case "--help", "-h":
			_, err := fmt.Fprintln(stdout, "Usage: termigo doctor [--json]")
			return err
		default:
			return fmt.Errorf("unknown doctor option %q", arg)
		}
	}

	report := doctor.Inspect()
	if jsonOutput {
		encoder := json.NewEncoder(stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(report)
	}

	_, _ = fmt.Fprintf(stdout, "Termigo doctor (%s/%s)\n\n", report.OS, report.Arch)
	for _, tool := range report.Tools {
		state := "missing"
		if tool.Available {
			state = "ready"
		}
		line := fmt.Sprintf("%-14s %s", tool.Name, state)
		if tool.Version != "" {
			line += "  " + tool.Version
		}
		_, _ = fmt.Fprintln(stdout, line)
	}
	_, err := fmt.Fprintln(stdout, "\nThis command only inspects locally installed tools; it never reads credentials.")
	return err
}

func writeUsage(stdout io.Writer) {
	_, _ = fmt.Fprint(stdout, `Termigo CLI

Usage:
  termigo <command>

Commands:
  doctor [--json]  Inspect local development and agent tools
  version          Print CLI version
  help             Show this help

The CLI is the Go companion for the Termigo desktop workspace.
`)
}
