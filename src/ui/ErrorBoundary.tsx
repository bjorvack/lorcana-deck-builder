import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  error: Error | null;
}

/**
 * Last-resort boundary: a crash in any view shows a recoverable panel
 * instead of unmounting the whole app (there is no telemetry backend, so the
 * failure is also logged to the console).
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('render error:', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="panel error-boundary" role="alert">
          <h3>Something went wrong</h3>
          <p className="muted">{this.state.error.message}</p>
          <div className="btnrow">
            <button
              type="button"
              className="btn"
              onClick={() => this.setState({ error: null })}
            >
              Try again
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => window.location.reload()}
            >
              Reload the app
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
