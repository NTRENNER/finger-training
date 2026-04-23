// scripts/validate_taur_vs_taud.js
// ─────────────────────────────────────────────────────────────
// Side-by-side leak-free LOO-CV of three-exp F-D model under two basis
// choices, the empirical defense for the tauD switch in src/model/threeExp.js:
//
//   tauR = [15, 90, 600]  — recovery time constants (the OLD basis)
//   tauD = [10, 30, 180]  — depletion time constants (CURRENT default)
//
// Both compared against Monod-Scherrer (CF + W'/T) on the same held-out
// reps. Per-grip three-exp prior is rebuilt for each LOO fold excluding
// the held-out rep so the prior never sees the test point.
//
// Usage:
//   node scripts/validate_taur_vs_taud.js path/to/all_reps.json
//
// Where all_reps.json is an array of rep objects with at minimum:
//   { id, hand: "L"|"R", grip: "Crusher"|"Micro"|...,
//     actual_time_s, avg_force_kg, failed: bool }
//
// Last run on Nathan's history (38 usable failures, 31 LOO-eligible folds):
//   λ=100   Monod 3.92  3e-tauR 3.77 (-3.8%)  3e-tauD 3.64 (-7.2%)
//   λ=1000  Monod 3.92  3e-tauR 3.70 (-5.7%)  3e-tauD 3.58 (-8.7%)
//   tauD wins at every λ tested; was the defense for switching the basis.

const fs = require('fs');
const path = require('path');

const dataPath = process.argv[2] || path.join(__dirname, '..', 'all_reps.json');
if (!fs.existsSync(dataPath)) {
  console.error(`Data file not found: ${dataPath}`);
  console.error(`Usage: node scripts/validate_taur_vs_taud.js <path/to/all_reps.json>`);
  process.exit(1);
}
const reps = JSON.parse(fs.readFileSync(dataPath));

const TAU_R = [15, 90, 600];   // recovery taus — the OLD basis
const TAU_D = [10, 30, 180];   // depletion taus — CURRENT default

function solve3(A, b) {
  const det = (
    A[0][0]*(A[1][1]*A[2][2]-A[1][2]*A[2][1])
  - A[0][1]*(A[1][0]*A[2][2]-A[1][2]*A[2][0])
  + A[0][2]*(A[1][0]*A[2][1]-A[1][1]*A[2][0])
  );
  if (Math.abs(det) < 1e-12) return null;
  const M = (col) => A.map((row, ri) => row.map((v, ci) => ci === col ? b[ri] : v));
  const D = (m) => (
    m[0][0]*(m[1][1]*m[2][2]-m[1][2]*m[2][1])
  - m[0][1]*(m[1][0]*m[2][2]-m[1][2]*m[2][0])
  + m[0][2]*(m[1][0]*m[2][1]-m[1][1]*m[2][0])
  );
  return [D(M(0))/det, D(M(1))/det, D(M(2))/det];
}
function solve2(A, b) {
  const det = A[0][0]*A[1][1]-A[0][1]*A[1][0];
  if (Math.abs(det) < 1e-12) return null;
  return [(b[0]*A[1][1]-b[1]*A[0][1])/det, (A[0][0]*b[1]-A[1][0]*b[0])/det];
}

// Mirrors fitThreeExpAmps in src/model/threeExp.js — non-negative LS with
// active-set enumeration, Gaussian shrinkage prior, given a tau basis.
function fitThreeExp(pts, prior, lambda, TAU) {
  if (!pts.length) return prior.slice();
  const X = pts.map(p => TAU.map(t => Math.exp(-p.T/t)));
  const y = pts.map(p => p.F);
  const XtX = [[0,0,0],[0,0,0],[0,0,0]];
  const Xty = [0,0,0];
  for (let i=0; i<pts.length; i++) for (let j=0; j<3; j++) {
    Xty[j] += X[i][j]*y[i];
    for (let k=0; k<3; k++) XtX[j][k] += X[i][j]*X[i][k];
  }
  const A = XtX.map((r,j) => r.map((v,k) => v + (j===k?lambda:0)));
  const rhs = Xty.map((v,j) => v + lambda*prior[j]);
  const cands = [];
  const sol3 = solve3(A, rhs);
  if (sol3 && sol3.every(v => v >= -1e-9)) cands.push(sol3.map(v => Math.max(0,v)));
  for (let z=0; z<3; z++) {
    const f = [0,1,2].filter(i => i !== z);
    const A2 = [[A[f[0]][f[0]], A[f[0]][f[1]]], [A[f[1]][f[0]], A[f[1]][f[1]]]];
    const sol2 = solve2(A2, [rhs[f[0]], rhs[f[1]]]);
    if (sol2 && sol2.every(v => v >= -1e-9)) {
      const s = [0,0,0]; s[f[0]] = Math.max(0,sol2[0]); s[f[1]] = Math.max(0,sol2[1]); cands.push(s);
    }
  }
  for (let nz=0; nz<3; nz++) if (A[nz][nz] > 1e-12) {
    const v = rhs[nz]/A[nz][nz];
    if (v >= -1e-9) { const s=[0,0,0]; s[nz]=Math.max(0,v); cands.push(s); }
  }
  cands.push([0,0,0]);
  const obj = (b) => {
    let r=0;
    for (let i=0; i<pts.length; i++) {
      const p = X[i][0]*b[0]+X[i][1]*b[1]+X[i][2]*b[2];
      r += (p-y[i])**2;
    }
    for (let j=0; j<3; j++) r += lambda*(b[j]-prior[j])**2;
    return r;
  };
  let best=cands[0], bo=obj(best);
  for (const c of cands.slice(1)) { const o=obj(c); if (o<bo) {best=c; bo=o;} }
  return best;
}
function predExp(b, T, TAU) {
  return b[0]*Math.exp(-T/TAU[0]) + b[1]*Math.exp(-T/TAU[1]) + b[2]*Math.exp(-T/TAU[2]);
}
function fitCF(pts) {
  if (pts.length<2) return null;
  let n=0,sx=0,sy=0,sxx=0,sxy=0;
  for (const p of pts){const x=1/p.T,y=p.F;n++;sx+=x;sy+=y;sxx+=x*x;sxy+=x*y;}
  const den=n*sxx-sx*sx;
  if (Math.abs(den)<1e-12) return null;
  const W=(n*sxy-sx*sy)/den;
  const CF=(sy-W*sx)/n;
  if (CF<0||W<0) return null;
  return {CF,W};
}
function predM(f, T) { return f.CF + f.W/T; }

function priorPerGripLeakFree(allReps, grip, excludeId, TAU) {
  const fails = allReps.filter(r =>
    r.grip === grip && r.failed && r.id !== excludeId
    && r.actual_time_s > 0 && r.avg_force_kg > 0
  );
  return fitThreeExp(fails.map(r => ({T: r.actual_time_s, F: r.avg_force_kg})), [0,0,0], 0, TAU);
}

function loo(allReps, hand, grip, lambdaScale) {
  const fails = allReps.filter(r => r.hand===hand && r.grip===grip && r.failed && r.actual_time_s>0 && r.avg_force_kg>0);
  if (fails.length < 3) return null;
  let mE=0, eR=0, eD=0, skipped=0;
  for (let i=0; i<fails.length; i++) {
    const test = fails[i];
    const train = fails.filter((_,j)=>j!==i);
    if (train.length < 2) {skipped++; continue;}
    const trainPts = train.map(r => ({T: r.actual_time_s, F: r.avg_force_kg}));
    const m = fitCF(trainPts);
    if (!m) {skipped++; continue;}
    const mp = predM(m, test.actual_time_s);

    const priorR = priorPerGripLeakFree(allReps, grip, test.id, TAU_R);
    const lambda = lambdaScale / Math.max(train.length, 1);
    const betaR = fitThreeExp(trainPts, priorR, lambda, TAU_R);
    const epR = predExp(betaR, test.actual_time_s, TAU_R);

    const priorD = priorPerGripLeakFree(allReps, grip, test.id, TAU_D);
    const betaD = fitThreeExp(trainPts, priorD, lambda, TAU_D);
    const epD = predExp(betaD, test.actual_time_s, TAU_D);

    mE += (mp - test.avg_force_kg)**2;
    eR += (epR - test.avg_force_kg)**2;
    eD += (epD - test.avg_force_kg)**2;
  }
  const N = fails.length - skipped;
  return {
    n: N,
    monod: Math.sqrt(mE/N),
    tauR:  Math.sqrt(eR/N),
    tauD:  Math.sqrt(eD/N),
  };
}

console.log("LOO-CV RMSE (kg) — Monod vs three-exp under tauR (old) vs tauD (current)\n");

for (const ls of [0, 1, 5, 25, 100, 250, 1000]) {
  console.log(`=== lambda scale = ${ls} ===`);
  console.log("hand | grip    |  N |  Monod  | 3e tauR | 3e tauD | tauR vs M | tauD vs M | tauD vs tauR");
  console.log("-----+---------+----+---------+---------+---------+-----------+-----------+-------------");
  let mT=0, eRT=0, eDT=0, nT=0;
  // Discover (hand, grip) buckets present in the data instead of hard-coding.
  const buckets = new Set();
  for (const r of reps) {
    if (r.failed && r.hand && r.grip && r.actual_time_s > 0 && r.avg_force_kg > 0) {
      buckets.add(`${r.hand}|${r.grip}`);
    }
  }
  for (const key of [...buckets].sort()) {
    const [hand, grip] = key.split("|");
    const r = loo(reps, hand, grip, ls);
    if (!r) continue;
    const dR = ((r.tauR - r.monod)/r.monod*100).toFixed(1);
    const dD = ((r.tauD - r.monod)/r.monod*100).toFixed(1);
    const dRD = ((r.tauD - r.tauR)/r.tauR*100).toFixed(1);
    const sR = dR > 0 ? "+" : "";
    const sD = dD > 0 ? "+" : "";
    const sRD = dRD > 0 ? "+" : "";
    console.log(`  ${hand}  | ${grip.padEnd(7)} | ${String(r.n).padStart(2)} | ${r.monod.toFixed(3).padStart(7)} | ${r.tauR.toFixed(3).padStart(7)} | ${r.tauD.toFixed(3).padStart(7)} | ${(sR+dR+'%').padStart(9)} | ${(sD+dD+'%').padStart(9)} | ${(sRD+dRD+'%').padStart(11)}`);
    mT += r.monod**2 * r.n; eRT += r.tauR**2 * r.n; eDT += r.tauD**2 * r.n; nT += r.n;
  }
  if (nT === 0) { console.log("  (no eligible buckets)\n"); continue; }
  const mA = Math.sqrt(mT/nT), eRA = Math.sqrt(eRT/nT), eDA = Math.sqrt(eDT/nT);
  const dRA = ((eRA-mA)/mA*100).toFixed(1);
  const dDA = ((eDA-mA)/mA*100).toFixed(1);
  const dRDA = ((eDA-eRA)/eRA*100).toFixed(1);
  const sRA = dRA > 0 ? "+" : "";
  const sDA = dDA > 0 ? "+" : "";
  const sRDA = dRDA > 0 ? "+" : "";
  console.log(`     | TOTAL   | ${String(nT).padStart(2)} | ${mA.toFixed(3).padStart(7)} | ${eRA.toFixed(3).padStart(7)} | ${eDA.toFixed(3).padStart(7)} | ${(sRA+dRA+'%').padStart(9)} | ${(sDA+dDA+'%').padStart(9)} | ${(sRDA+dRDA+'%').padStart(11)}\n`);
}
