import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import { ErrorBoundary } from './ui/ErrorBoundary.jsx';
import reportWebVitals from './reportWebVitals';
import { registerServiceWorker } from './serviceWorkerRegistration.js';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();

// The production bundle is precached so the app can reopen without a
// network connection. Cloud data remains network-only; local queues own
// offline writes and replay them after connectivity returns.
registerServiceWorker();
