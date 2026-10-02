package coder

import "time"

// processWaitDelay bounds how long Wait blocks on the output pipe after a
// command is stopped, so a grandchild holding the pipe cannot hang the tool.
const processWaitDelay = 5 * time.Second
