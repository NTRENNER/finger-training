const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const buildDir = path.join(root, "build");
const workerPath = path.join(buildDir, "service-worker.js");
const manifestPath = path.join(buildDir, "asset-manifest.json");

if (!fs.existsSync(workerPath) || !fs.existsSync(manifestPath)) {
  throw new Error("Production build is missing; run npm run build first");
}

const listeners = {};
const stored = new Map();
let shellUrls = [];
const cache = {
  async addAll(urls) {
    shellUrls = [...urls];
    for (const url of urls) stored.set(url, { cachedUrl: url });
  },
  async add(url) {
    stored.set(url, { cachedUrl: url });
  },
  async match(request) {
    const key = typeof request === "string"
      ? request
      : new URL(request.url).pathname;
    return stored.get(key);
  },
  async put(request, response) {
    const key = typeof request === "string"
      ? request
      : new URL(request.url).pathname;
    stored.set(key, response);
  },
};
const caches = {
  async open() { return cache; },
  async keys() { return []; },
  async delete() { return true; },
  async match(request) { return cache.match(request); },
};
const self = {
  location: { origin: "https://finger-training.test" },
  clients: { async claim() {} },
  addEventListener(type, listener) { listeners[type] = listener; },
};

vm.runInNewContext(fs.readFileSync(workerPath, "utf8"), {
  self,
  caches,
  URL,
  Promise,
  fetch: async () => { throw new Error("offline"); },
});

async function waitForLifecycle(type, extra = {}) {
  let pending;
  listeners[type]({
    ...extra,
    waitUntil(promise) { pending = promise; },
  });
  await pending;
}

async function run() {
  await waitForLifecycle("install");
  assert(stored.has("/index.html"), "install did not cache /index.html");
  for (const url of shellUrls) {
    if (url === "/") continue;
    assert(
      fs.existsSync(path.join(buildDir, url.replace(/^\//, ""))),
      `cached shell file does not exist: ${url}`
    );
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  for (const asset of Object.values(manifest.files || {})) {
    if (typeof asset === "string" && /\.(?:css|js)$/.test(asset)) {
      assert(stored.has(asset), `install did not cache ${asset}`);
    }
  }
  for (const asset of ["/manifest.json", "/favicon.ico", "/logo192.png", "/logo512.png"]) {
    const filePath = path.join(buildDir, asset.replace(/^\//, ""));
    if (fs.existsSync(filePath)) {
      assert(stored.has(asset), `install did not cache optional shell file ${asset}`);
    }
  }

  let responsePromise;
  listeners.fetch({
    request: {
      method: "GET",
      mode: "navigate",
      url: "https://finger-training.test/analysis",
    },
    respondWith(promise) { responsePromise = promise; },
  });
  const response = await responsePromise;
  assert.strictEqual(
    response.cachedUrl,
    "/index.html",
    "offline navigation did not fall back to the cached app shell"
  );

  console.log("Verified cached app-shell install and offline navigation fallback");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
