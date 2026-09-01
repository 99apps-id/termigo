import { Component, type ReactNode } from "react";

type Props = {
  /** Stable key for the chat session; changing it resets the boundary. */
  sessionId?: string;
  children: ReactNode;
};

type State = {
  error: Error | null;
};

/**
 * Error boundary around the AI chat transcript.
 *
 * A render error in the message list (a malformed part, a bad tool card, a
 * React "Maximum update depth" from an unstable store selector) used to blank
 * the whole panel silently — nothing rendered, no message, and only a restart
 * recovered it. This boundary catches those errors and shows a recovery card
 * with the cause and a reset button instead, so the panel is never a silent
 * white void.
 *
 * Keyed by `sessionId`: switching sessions (or resetting) remounts the
 * subtree, which clears the error state naturally.
 */
export class AiChatErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prevProps: Props): void {
    if (prevProps.sessionId !== this.props.sessionId && this.state.error) {
      this.setState({ error: null });
    }
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    const message = this.state.error.message || String(this.state.error);
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-[12px]">
        <div className="flex items-center gap-2 text-foreground">
          <span className="size-1.5 shrink-0 rounded-full bg-destructive" />
          <span className="font-medium">The chat hit a rendering error</span>
        </div>
        <p className="text-muted-foreground">
          <code className="break-all">{message}</code>
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={this.reset}
            className="rounded border border-border/60 px-2 py-1 text-[11px] text-foreground transition-colors hover:bg-muted"
          >
            Reset view
          </button>
        </div>
      </div>
    );
  }
}
