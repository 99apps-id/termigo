p = "C:/project/termigo/src/modules/ai/lib/agent.ts"
data = open(p, "rb").read()

# Remove the stray '+' diff markers that got baked into the source.
# They only appear in the block I just added, so exact replacements are safe.
replacements = [
    (b"+  // Fallback message-count cap", b"  // Fallback message-count cap"),
    (b"+  // Trim from the front", b"  // Trim from the front"),
    (b"+  const cappedHistory", b"  const cappedHistory"),
    (b"+  if (cappedHistory.capped) {", b"  if (cappedHistory.capped) {"),
    (b"+    fireAndForget(", b"    fireAndForget("),
    (b"+      logInfo(", b"      logInfo("),
    (b"+        `[ai] context cap:", b"        `[ai] context cap:"),
    (b"+          `(${finalHistory.length}", b"          `(${finalHistory.length}"),
    (b"+          `limit ${MAX_HISTORY_MESSAGES}", b"          `limit ${MAX_HISTORY_MESSAGES}"),
    (b"+      ),", b"      ),"),
    (b"+      \"context-cap-log\",", b"      \"context-cap-log\","),
    (b"+    );", b"    );"),
    (b"+  }", b"  }"),
    (b"+  const promptHistory", b"  const promptHistory"),
    (b"+  const prompt =", b"  const prompt ="),
    (b"+    stableSystem,", b"    stableSystem,"),
    (b"+    opts.planMode ? PLAN_MODE_PROMPT : null,", b"    opts.planMode ? PLAN_MODE_PROMPT : null,"),
    (b"+    promptHistory,", b"    promptHistory,"),
    (b"+    provider,", b"    provider,"),
]
for old, new in replacements:
    data = data.replace(old, new)

open(p, "wb").write(data)
print("done")
