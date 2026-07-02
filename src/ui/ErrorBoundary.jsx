// ─────────────────────────────────────────────────────────────
// ERROR BOUNDARIES (added 2026-07-01)
// ─────────────────────────────────────────────────────────────
// Before this file the tree had NO boundary: one throw anywhere —
// most plausibly a chart card doing curve-fit math over user-editable
// history (the History rep editor accepts arbitrary floats) — white-
// screened the whole app. And because state initializes from the same
// localStorage that produced the throw, the whitescreen could recur
// on every subsequent load with no recovery path short of devtools.
//
// Two layers:
//   • <ErrorBoundary>  — app root. Full-page fallback with Try Again
//     (re-mounts the tree) and Reload App. Deliberately NO "clear
//     data" button: local-first app, LS is the source of truth, a
//     panic-wipe affordance is a data-loss footgun.
//   • <CardBoundary>   — per analysis/chart card. One card failing
//     renders a compact inline error and the REST of the page keeps
//     working; the card name tells us where to look.

import React from "react";
import { C } from "./theme.js";

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    // Console breadcrumb only — no telemetry in this app.
    console.error("ErrorBoundary caught:", error, info?.componentStack);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{
        minHeight: "100vh", display: "flex", alignItems: "center",
        justifyContent: "center", background: C.bg, color: C.text,
        fontFamily: "system-ui, sans-serif", padding: 24,
      }}>
        <div style={{
          maxWidth: 440, textAlign: "center", background: C.card,
          border: `1px solid ${C.border}`, borderRadius: 12, padding: "32px 28px",
        }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🧗</div>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
            Something broke
          </div>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 6 }}>
            The app hit an unexpected error. Your training data is safe —
            it lives on this device and in the cloud sync.
          </div>
          <div style={{
            fontSize: 11, color: C.muted, marginBottom: 20,
            fontFamily: "monospace", overflowWrap: "anywhere",
          }}>
            {String(this.state.error?.message || this.state.error)}
          </div>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              background: C.blue, color: "#fff", border: "none",
              borderRadius: 8, padding: "10px 18px", fontSize: 14,
              fontWeight: 600, cursor: "pointer", marginRight: 10,
            }}>
            Try again
          </button>
          <button
            onClick={() => window.location.reload()}
            style={{
              background: "transparent", color: C.text,
              border: `1px solid ${C.border}`, borderRadius: 8,
              padding: "10px 18px", fontSize: 14, cursor: "pointer",
            }}>
            Reload app
          </button>
        </div>
      </div>
    );
  }
}

// Per-card boundary. Same catch mechanics, card-sized fallback. `name`
// labels the fallback and the console breadcrumb so a report like
// "Peak Force card is broken" maps straight to a component.
export class CardBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error(`CardBoundary[${this.props.name || "card"}] caught:`, error, info?.componentStack);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{
        background: C.card, border: `1px solid ${C.border}`,
        borderRadius: 12, padding: "20px 24px", marginBottom: 16,
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
          {this.props.name || "This card"} couldn't render
        </div>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>
          The rest of the page still works. This is usually one bad data
          point — a rep with an impossible load or duration.
        </div>
        <button
          onClick={() => this.setState({ error: null })}
          style={{
            background: "transparent", color: C.blue,
            border: `1px solid ${C.border}`, borderRadius: 6,
            padding: "6px 12px", fontSize: 12, cursor: "pointer",
          }}>
          Retry
        </button>
      </div>
    );
  }
}
