import React from 'react';
import { PageFrame, Btn } from '../ui/components.js';
import { CardBoundary } from '../ui/ErrorBoundary.jsx';
import { C } from '../ui/theme.js';
import { PredictionAccuracyCard } from './cards/PredictionAccuracyCard.jsx';

export function ResearchView({ history, unit, signedIn, historySynced, onOpenSettings }) {
  return <PageFrame style={{ padding: '24px 16px' }}>
    <header style={{ marginBottom: 24 }}>
      <div style={{ color: C.purple, fontSize: 13, fontWeight: 700 }}>BETA · RESEARCH</div>
      <h1 style={{ margin: '8px 0 12px' }}>Prediction research</h1>
      <p style={{ color: C.muted, lineHeight: 1.5 }}>
        Compare saved predictions with recorded workouts and review candidate models.
        These comparisons do not change your prescribed loads.
      </p>
      <a href="/" style={{ color: C.blue }}>Back to training</a>
    </header>
    {!signedIn && <div style={{ marginBottom: 20 }}>
      <p style={{ color: C.muted }}>Showing workouts saved on this device. Sign in to use your synced history.</p>
      <Btn onClick={onOpenSettings}>Sign in</Btn>
    </div>}
    {signedIn && !historySynced
      ? <p role="status" style={{ color: C.muted }}>Loading your synced history…</p>
      : <CardBoundary name="Prediction accuracy">
          <PredictionAccuracyCard history={history} unit={unit} />
        </CardBoundary>}
  </PageFrame>;
}
