import { Component, type ErrorInfo, type ReactNode } from 'react';
import { panelHeadingCls } from './styles';

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
        <div
          className="bg-panel border border-line rounded-[10px] p-3 m-4 flex flex-col gap-2.5 items-start"
          role="alert"
        >
          <h3 className={panelHeadingCls}>Something went wrong</h3>
          <p className="text-parchment-muted">{this.state.error.message}</p>
          <div className="flex gap-2 mb-2">
            <button
              type="button"
              className="bg-panel-2 text-parchment border border-line rounded-lg py-[7px] px-3 cursor-pointer text-sm hover:border-gold"
              onClick={() => this.setState({ error: null })}
            >
              Try again
            </button>
            <button
              type="button"
              className="bg-panel-2 text-parchment border border-line rounded-lg py-[7px] px-3 cursor-pointer text-sm hover:border-gold"
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
