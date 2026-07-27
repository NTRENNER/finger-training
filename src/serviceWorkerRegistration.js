export function registerServiceWorker() {
  if (process.env.NODE_ENV !== "production") return Promise.resolve(null);
  if (!("serviceWorker" in navigator)) return Promise.resolve(null);

  const base = process.env.PUBLIC_URL || "";
  return navigator.serviceWorker
    .register(`${base}/service-worker.js`)
    .catch((error) => {
      console.warn("Service worker registration failed:", error?.message || error);
      return null;
    });
}
