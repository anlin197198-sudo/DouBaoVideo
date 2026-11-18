import { Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./style.css";
import { App } from "./App";

class ApplicationErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    console.error("Renderer failed to display the workspace");
  }
  render() {
    if (this.state.failed)
      return (
        <div className="empty">
          <h1>工作区显示遇到问题</h1>
          <button className="primary" onClick={() => location.reload()}>
            重新打开工作区
          </button>
        </div>
      );
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <ApplicationErrorBoundary>
    <App />
  </ApplicationErrorBoundary>,
);
