import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = {
  children: ReactNode;
};

type State = {
  error: Error | null;
};

/**
 * Boundary around the whole app root.
 *
 * Tabs stay mounted so their PTYs and dev servers keep streaming, which is also
 * why a render error anywhere used to be total: React unmounts the root, the
 * window becomes a blank frame, and every running shell under it is gone with
 * nothing on screen to say why. This catches that error and leaves a screen that
 * names the cause and offers a retry first, because the only expensive step is
 * the reload (a webview reload reaps every PTY).
 */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[termigo] render error:", error, info.componentStack);
  }

  private retry = (): void => {
    this.setState({ error: null });
  };

  private reload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    const message = this.state.error.message || String(this.state.error);
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background p-6">
        <div
          role="alert"
          className="w-full max-w-lg rounded-lg border border-destructive/40 bg-card px-5 py-4"
        >
          <div className="flex items-center gap-2">
            <span className="size-1.5 shrink-0 rounded-full bg-destructive" />
            <h1 className="text-sm font-medium text-foreground">
              Termigo stopped rendering
            </h1>
          </div>
          <p className="mt-2 text-[12px] text-muted-foreground">
            The interface hit an error while rendering, so the tabs and the
            processes running under them are not reachable from this window. The
            cause is below and in the app log.
          </p>
          <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded border border-border/60 bg-muted/40 p-2 text-[11px] text-muted-foreground">
            {message}
          </pre>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={this.retry}
              className="rounded border border-border/60 px-2.5 py-1 text-[11px] text-foreground transition-colors hover:bg-muted"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={this.reload}
              className="rounded border border-destructive/40 px-2.5 py-1 text-[11px] text-destructive transition-colors hover:bg-destructive/10"
            >
              Reload the window
            </button>
          </div>
        </div>
      </div>
    );
  }
}
