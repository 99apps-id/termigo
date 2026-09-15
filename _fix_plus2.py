p = "C:/project/termigo/src/modules/ai/lib/agent.ts"
data = open(p, "rb").read()

replacements = [
    (b"+  // pruning can all leave a session", b"  // pruning can all leave a session"),
    (b"+  // the budget but still make context assembly", b"  // the budget but still make context assembly"),
    (b"+  // HISTORY_TAIL_KEEP messages so the current task stays intact.", b"  // HISTORY_TAIL_KEEP messages so the current task stays intact."),
    (b"+\r\n", b"\r\n"),
    (b"+  const promptHistory = cappedHistory.messages;\r\n", b"  const promptHistory = cappedHistory.messages;\r\n"),
]
for old, new in replacements:
    data = data.replace(old, new)

open(p, "wb").write(data)
print("done")
