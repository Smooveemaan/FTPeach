import React from 'react';
import type { CSSProperties, ErrorInfo, ReactNode } from 'react';
import i18n from '../i18n/index.ts';

interface ErrorBoundaryProps {
  children: ReactNode;
  local?: boolean;
  style?: CSSProperties;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export default class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(i18n.t('errorBoundary.consoleLogPrefix'), error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    const message = this.state.error.stack || this.state.error.message || String(this.state.error);
    return (
      <div
        className={`error-boundary${this.props.local ? ' error-boundary-local' : ''}`}
        style={this.props.style}
        role="alert"
      >
        <div className="error-boundary-card">
          <h1>{i18n.t('errorBoundary.title')}</h1>
          <p>{i18n.t('errorBoundary.message')}</p>
          <pre className="error-boundary-details">{message}</pre>
          <button
            type="button"
            className="btn btn-primary btn-primary-quiet"
            onClick={() =>
              this.props.local ? this.setState({ error: null }) : window.location.reload()
            }
          >
            {i18n.t(this.props.local ? 'paneMenu.refresh' : 'errorBoundary.reload')}
          </button>
        </div>
      </div>
    );
  }
}
