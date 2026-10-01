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
let currentCache;
const deletedCaches = [];
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
  async open(name) { currentCache = name; return cache; },
  async keys() { return [currentCache, "finger-training-shell-old-cra", "unrelated-cache"]; },
  async delete(name) { deletedCaches.push(name); return true; },
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

  // Both compute workers must be available without a network connection.
  for (const name of ["predictionBuild.worker-", "historicalEvaluation.worker-"]) {
    assert(shellUrls.some(url => url.includes(name)), `missing cached worker: ${name}`);
  }
  await waitForLifecycle("activate");
  assert.deepStrictEqual(deletedCaches, ["finger-training-shell-old-cra"],
    "activation must retire old app caches while preserving unrelated caches");

  for (const pathname of ["/analysis", "/research", "/research/"]) {
    let responsePromise;
    listeners.fetch({
      request: { method: "GET", mode: "navigate", url: `https://finger-training.test${pathname}` },
      respondWith(promise) { responsePromise = promise; },
    });
    const response = await responsePromise;
    assert.strictEqual(response.cachedUrl, "/index.html",
      `offline ${pathname} did not fall back to the cached app shell`);
  }

  console.log("Verified app shell, both compute workers, cache upgrades, and offline analysis/research routes");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
