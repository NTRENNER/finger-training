import React from 'react';
import { PageFrame, Btn } from '../ui/components.js';
import { CardBoundary } from '../ui/ErrorBoundary.jsx';
import { C } from '../ui/theme.js';
import { PredictionAccuracyCard } from './cards/PredictionAccuracyCard.jsx';
import { VolumeExperimentReview } from './cards/VolumeExperimentReview.jsx';

export function ResearchView({ history, activities, unit, signedIn, historySynced, onOpenSettings,
  volumeExperiments = {}, onSaveVolumeExperiment, volumeReady = true }) {
  return <PageFrame style={{ padding: '24px 16px' }}>
    <header style={{ marginBottom: 24 }}>
      <div style={{ color: C.purple, fontSize: 13, fontWeight: 700 }}>BETA · RESEARCH</div>
      <h1 style={{ margin: '8px 0 12px' }}>Training research</h1>
      <p style={{ color: C.muted, lineHeight: 1.5 }}>
        Review your training experiments, compare saved predictions with recorded workouts,
        and evaluate candidate models. These comparisons do not change your prescribed loads.
      </p>
      <a href="/" style={{ color: C.blue }}>Back to training</a>
    </header>
    {!signedIn && <div style={{ marginBottom: 20 }}>
      <p style={{ color: C.muted }}>Showing workouts saved on this device. Sign in to use your synced history.</p>
      <Btn onClick={onOpenSettings}>Sign in</Btn>
    </div>}
    {signedIn && !historySynced
      ? <p role="status" style={{ color: C.muted }}>Loading your synced history…</p>
      : <><CardBoundary name="Volume Beta review">
          <VolumeExperimentReview experiments={volumeExperiments} history={history} activities={activities}
            unit={unit} onSave={onSaveVolumeExperiment} ready={volumeReady} />
        </CardBoundary><CardBoundary name="Prediction accuracy">
          <PredictionAccuracyCard history={history} activities={activities} unit={unit} />
        </CardBoundary></>}
  </PageFrame>;
}
