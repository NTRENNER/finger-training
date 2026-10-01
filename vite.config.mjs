import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig(({ mode }) => {
  // Preserve existing local/Vercel public variable names. Never substitute
  // process.env wholesale: server-side deployment secrets must stay private.
  const env = loadEnv(mode, root, 'REACT_APP_');
  let sha = process.env.VERCEL_GIT_COMMIT_SHA || env.REACT_APP_BUILD_SHA;
  if (!sha) {
    try { sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); }
    catch { sha = 'dev'; }
  }
  return {
    plugins: [react()],
    define: {
      'process.env.REACT_APP_SUPABASE_URL': JSON.stringify(env.REACT_APP_SUPABASE_URL || ''),
      'process.env.REACT_APP_SUPABASE_ANON_KEY': JSON.stringify(env.REACT_APP_SUPABASE_ANON_KEY || ''),
      'process.env.REACT_APP_BUILD_SHA': JSON.stringify(sha),
      'process.env.REACT_APP_BUILD_TIME': JSON.stringify(new Date().toISOString()),
      'process.env.PUBLIC_URL': JSON.stringify(''),
    },
    server: { port: Number(process.env.PORT) || 3000 },
    preview: { port: 5000 },
    build: { outDir: 'build', assetsDir: 'static', target: 'baseline-widely-available', manifest: true },
    worker: { format: 'es' },
  };
});
