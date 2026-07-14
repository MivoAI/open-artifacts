import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface RenderErrorBoundaryProps {
  packageName: string;
  children: ReactNode;
}

interface RenderErrorBoundaryState {
  error: Error | null;
}

export class RenderErrorBoundary extends Component<
  RenderErrorBoundaryProps,
  RenderErrorBoundaryState
> {
  override state: RenderErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): RenderErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`Artifact Package ${this.props.packageName} failed`, error, info);
  }

  override render() {
    if (this.state.error) {
      return (
        <section className="render-failure">
          <span>Render failed</span>
          <h2>{this.props.packageName}</h2>
          <p>{this.state.error.message}</p>
          <small>编辑右侧 JSON 或切换 package 后会重新挂载。</small>
        </section>
      );
    }

    return this.props.children;
  }
}
