// Package version carries the build identity the CLI reports.
package version

// These are stamped at build time with -ldflags.
var (
	Version   = "dev"
	Commit    = ""
	BuildDate = ""
)

// Name is the product name shown to the operator.
const Name = "Termigo"

// UserAgent identifies the client on outgoing requests.
const UserAgent = "termigo-cli"
