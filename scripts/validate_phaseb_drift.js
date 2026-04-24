// validate_phaseb_drift.js
// Compare PRE-Phase-B (Monod-only prescribedLoad, Monod-CF-update for
// empiricalPrescription failure case) vs POST-Phase-B (three-exp paths)
// on Nathan's history snapshot. Reports the kg drift per (hand, grip,
// targetTime) cell so we can spot any prescriptions that move >>20%.

const fs = require('fs');
const reps = JSON.parse(fs.readFileSync('/sessions/confident-stoic-lamport/all_reps.json'));

// Pad reps with target_duration / failed defaults expected by prescription.js
for (const r of reps) {
  if (r.target_duration == null && r.actual_time_s) r.target_duration = Math.round(r.actual_time_s);
}

// ── Embedded copies of fitCF, fitCFWithSuccessFloor, fitThreeExpAmps,
//    fitThreeExpAmpsWithSuccessFloor, predForceThreeExp, plus the old
//    and new empiricalPrescription/prescribedLoad/buildThreeExpPriors. ──

const TAU_D = [10, 30, 180];

function effectiveLoad(r) {
  const f = Number(r.avg_force_kg), w = Number(r.weight_kg);
  if (f > 0 && f < 500) return f;
  if (w > 0) return w;
  return 0;
}
const loadedWeight = effectiveLoad;

function fitCF(pts) {
  if (pts.length<2) return null;
  let n=0,sx=0,sy=0,sxx=0,sxy=0;
  for (const p of pts){const x=p.x,y=p.y;n++;sx+=x;sy+=y;sxx+=x*x;sxy+=x*y;}
  const den=n*sxx-sx*sx; if (Math.abs(den)<1e-12) return null;
  const W=(n*sxy-sx*sy)/den, CF=(sy-W*sx)/n;
  if (CF<0||W<0) return null;
  return {CF,W};
}
function fitCFWeightedRaw(pts) {
  if (!pts || pts.length < 2) return null;
  let sw=0,swx=0,swy=0,swxx=0,swxy=0,n=0;
  for (const p of pts) {
    const w = p.w == null ? 1 : p.w;
    if (!(w > 0)) continue;
    sw += w; swx += w*p.x; swy += w*p.y; swxx += w*p.x*p.x; swxy += w*p.x*p.y; n++;
  }
  if (n < 2 || sw <= 0) return null;
  const den = sw*swxx - swx*swx; if (Math.abs(den) < 1e-12) return null;
  const W = (sw*swxy - swx*swy) / den, CF = (swy - W*swx) / sw;
  return {CF, W};
}
function fitCFWithSuccessFloor(failurePts, successPts) {
  const failures = (failurePts || []).map(p => ({ x: p.x, y: p.y, w: 1 }));
  const successes = successPts || [];
  if (failures.length + successes.length < 2) return null;
  let fit = failures.length >= 2 ? fitCFWeightedRaw(failures) : null;
  if (!fit) {
    const seed = [...failures, ...successes.map(p => ({x:p.x, y:p.y, w:1}))];
    fit = fitCFWeightedRaw(seed);
  }
  if (!fit) return null;
  fit = { CF: Math.max(0, fit.CF), W: Math.max(0, fit.W) };
  if (successes.length === 0) return fit;
  const succWeights = successes.map(() => 0);
  for (let iter = 0; iter < 60; iter++) {
    let any = false;
    for (let i = 0; i < successes.length; i++) {
      const s = successes[i];
      const pred = fit.CF + fit.W * s.x;
      if (pred < s.y - 0.1) { succWeights[i] += 4; any = true; }
    }
    if (!any) break;
    const aug = [...failures];
    for (let i = 0; i < successes.length; i++)
      if (succWeights[i] > 0) aug.push({ x: successes[i].x, y: successes[i].y, w: succWeights[i] });
    const next = fitCFWeightedRaw(aug);
    if (!next) break;
    fit = { CF: Math.max(0, next.CF), W: Math.max(0, next.W) };
  }
  return fit;
}

function solve3(A, b) {
  const det = A[0][0]*(A[1][1]*A[2][2]-A[1][2]*A[2][1])
            - A[0][1]*(A[1][0]*A[2][2]-A[1][2]*A[2][0])
            + A[0][2]*(A[1][0]*A[2][1]-A[1][1]*A[2][0]);
  if (Math.abs(det) < 1e-12) return null;
  const M = (col) => A.map((row,ri) => row.map((v,ci) => ci === col ? b[ri] : v));
  const D = (m) => m[0][0]*(m[1][1]*m[2][2]-m[1][2]*m[2][1])
                  - m[0][1]*(m[1][0]*m[2][2]-m[1][2]*m[2][0])
                  + m[0][2]*(m[1][0]*m[2][1]-m[1][1]*m[2][0]);
  return [D(M(0))/det, D(M(1))/det, D(M(2))/det];
}
function solve2(A, b) {
  const det = A[0][0]*A[1][1]-A[0][1]*A[1][0];
  if (Math.abs(det) < 1e-12) return null;
  return [(b[0]*A[1][1]-b[1]*A[0][1])/det, (A[0][0]*b[1]-A[1][0]*b[0])/det];
}
function fitThreeExpAmps(pts, opts = {}) {
  const taus = opts.taus || TAU_D;
  const prior = opts.prior || [0,0,0];
  const lambda = opts.lambda == null ? 0 : opts.lambda;
  if (!pts || pts.length === 0) return prior.slice();
  const X = pts.map(p => taus.map(t => Math.exp(-p.T/t)));
  const y = pts.map(p => p.F);
  const w = pts.map(p => p.w == null ? 1 : p.w);
  const XtX = [[0,0,0],[0,0,0],[0,0,0]];
  const Xty = [0,0,0];
  for (let i=0; i<pts.length; i++) {
    if (!(w[i] > 0)) continue;
    for (let j=0; j<3; j++) {
      Xty[j] += w[i]*X[i][j]*y[i];
      for (let k=0; k<3; k++) XtX[j][k] += w[i]*X[i][j]*X[i][k];
    }
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
      if (!(w[i] > 0)) continue;
      const p = X[i][0]*b[0]+X[i][1]*b[1]+X[i][2]*b[2];
      r += w[i]*(p-y[i])**2;
    }
    for (let j=0; j<3; j++) r += lambda*(b[j]-prior[j])**2;
    return r;
  };
  let best=cands[0], bo=obj(best);
  for (const c of cands.slice(1)) { const o=obj(c); if (o<bo) {best=c; bo=o;} }
  return best;
}
function predForceThreeExp(amps, T, taus = null) {
  const tau = taus || TAU_D;
  return amps[0]*Math.exp(-T/tau[0]) + amps[1]*Math.exp(-T/tau[1]) + amps[2]*Math.exp(-T/tau[2]);
}
function fitThreeExpAmpsWithSuccessFloor(failurePts, successPts, opts = {}) {
  const { maxIter = 60, tol = 0.1, weightStep = 4.0, ...fitOpts } = opts;
  const failures = (failurePts || []).map(p => ({ T: p.T, F: p.F, w: 1 }));
  const successes = successPts || [];
  if (failures.length + successes.length < 2) return null;
  let amps = failures.length >= 1 ? fitThreeExpAmps(failures, fitOpts) : null;
  if (!amps || (amps[0]+amps[1]+amps[2]) <= 0) {
    const seed = [...failures, ...successes.map(p => ({T:p.T, F:p.F, w:1}))];
    amps = fitThreeExpAmps(seed, fitOpts);
  }
  if (!amps) return null;
  if (successes.length === 0) return amps;
  const sw = successes.map(() => 0);
  for (let iter=0; iter<maxIter; iter++) {
    let any=false;
    for (let i=0; i<successes.length; i++) {
      const s = successes[i];
      const pred = predForceThreeExp(amps, s.T, fitOpts.taus);
      if (pred < s.F - tol) { sw[i] += weightStep; any=true; }
    }
    if (!any) break;
    const aug = [...failures];
    for (let i=0; i<successes.length; i++)
      if (sw[i] > 0) aug.push({T: successes[i].T, F: successes[i].F, w: sw[i]});
    const next = fitThreeExpAmps(aug, fitOpts);
    if (!next) break;
    amps = next;
  }
  return amps;
}
function buildThreeExpPriors(history) {
  const byGrip = {};
  for (const r of history) {
    if (!r.failed || !r.grip) continue;
    if (!(r.avg_force_kg > 0 && r.avg_force_kg < 500)) continue;
    if (!(r.actual_time_s > 0)) continue;
    if (!byGrip[r.grip]) byGrip[r.grip] = [];
    byGrip[r.grip].push({T: r.actual_time_s, F: r.avg_force_kg});
  }
  const out = new Map();
  for (const [g, pts] of Object.entries(byGrip)) {
    if (pts.length < 2) continue;
    out.set(g, fitThreeExpAmps(pts, {lambda: 0}));
  }
  return out;
}

// ── prescribedLoad: OLD (Monod success-floor) ──
function prescribedLoad_OLD(history, hand, grip, T) {
  if (!history || !T) return null;
  const handMatch = r => r.hand === hand && (!grip || r.grip === grip)
    && r.actual_time_s > 0 && effectiveLoad(r) > 0;
  const failures = history.filter(r => r.failed && handMatch(r));
  const successes = history.filter(r => !r.failed && handMatch(r)
    && r.target_duration > 0 && r.actual_time_s >= r.target_duration);
  if (failures.length < 2 && successes.length < 2) return null;
  const fp = failures.map(r => ({x: 1/r.actual_time_s, y: effectiveLoad(r)}));
  const sp = successes.map(r => ({x: 1/r.actual_time_s, y: effectiveLoad(r)}));
  const fit = fitCFWithSuccessFloor(fp, sp);
  if (!fit) return null;
  return Math.round((fit.CF + fit.W/T) * 10) / 10;
}

// ── prescribedLoad: NEW (three-exp success-floor; Monod fallback) ──
function prescribedLoad_NEW(history, hand, grip, T, priors) {
  if (!history || !T) return null;
  const handMatch = r => r.hand === hand && (!grip || r.grip === grip)
    && r.actual_time_s > 0 && effectiveLoad(r) > 0;
  const failures = history.filter(r => r.failed && handMatch(r));
  const successes = history.filter(r => !r.failed && handMatch(r)
    && r.target_duration > 0 && r.actual_time_s >= r.target_duration);
  if (failures.length < 2 && successes.length < 2) return null;
  const prior = (grip && priors) ? priors.get(grip) : null;
  if (prior && (prior[0]+prior[1]+prior[2]) > 0 && failures.length >= 1) {
    const tep = failures.map(r => ({T: r.actual_time_s, F: effectiveLoad(r)}));
    const tes = successes.map(r => ({T: r.actual_time_s, F: effectiveLoad(r)}));
    const lambda = 100 / Math.max(failures.length, 1);
    const amps = fitThreeExpAmpsWithSuccessFloor(tep, tes, {prior, lambda});
    if (amps && (amps[0]+amps[1]+amps[2]) > 0) {
      const v = predForceThreeExp(amps, T);
      if (v > 0) return Math.round(v * 10) / 10;
    }
  }
  // Cold-start fallback
  return prescribedLoad_OLD(history, hand, grip, T);
}

// ── empiricalPrescription failure-case OLD vs NEW ──
function empFailure_OLD(history, hand, grip, T_target, F_actual, T_actual) {
  const fp = history.filter(r => r.failed && r.hand===hand && r.grip===grip
    && r.actual_time_s > 0 && effectiveLoad(r) > 0)
    .map(r => ({x: 1/r.actual_time_s, y: effectiveLoad(r)}));
  const fit = fp.length >= 2 ? fitCF(fp) : null;
  if (fit && F_actual > fit.CF) {
    const Wp = (F_actual - fit.CF) * T_actual;
    return Math.round(Math.max(fit.CF + Wp/T_target, fit.CF) * 10) / 10;
  }
  return Math.round(F_actual * Math.max(0.7, T_actual/T_target) * 10) / 10;
}
function empFailure_NEW(history, hand, grip, T_target, F_actual, T_actual, priors) {
  const fps = history.filter(r => r.failed && r.hand===hand && r.grip===grip
    && r.actual_time_s > 0 && effectiveLoad(r) > 0);
  const prior = priors ? priors.get(grip) : null;
  if (prior && (prior[0]+prior[1]+prior[2]) > 0 && fps.length >= 1) {
    const tep = fps.map(r => ({T: r.actual_time_s, F: effectiveLoad(r)}));
    const lambda = 100 / Math.max(fps.length, 1);
    const amps = fitThreeExpAmps(tep, {prior, lambda});
    if (amps && (amps[0]+amps[1]+amps[2]) > 0) {
      const Fpa = predForceThreeExp(amps, T_actual);
      if (Fpa > 0) {
        const scale = F_actual / Fpa;
        if (scale >= 0.5 && scale <= 2.0) {
          const Fpt = predForceThreeExp(amps, T_target);
          const next = Fpt * scale;
          if (next > 0) return Math.round(next * 10) / 10;
        }
      }
    }
  }
  return empFailure_OLD(history, hand, grip, T_target, F_actual, T_actual);
}

// ── Run comparison ──
const priors = buildThreeExpPriors(reps);
const TARGETS = [{label:"Power", T:7}, {label:"Strength", T:45}, {label:"Capacity", T:120}];
const HANDS = ["L", "R"];
const GRIPS = ["Crusher", "Micro"];

console.log("PRESCRIBED LOAD (curve fallback) — kg drift");
console.log("hand | grip    | zone     |   OLD  |   NEW  |   Δkg  |   Δ%");
console.log("-----+---------+----------+--------+--------+--------+--------");
let maxDrift = 0;
for (const grip of GRIPS) for (const hand of HANDS) for (const {label, T} of TARGETS) {
  const o = prescribedLoad_OLD(reps, hand, grip, T);
  const n = prescribedLoad_NEW(reps, hand, grip, T, priors);
  if (o == null && n == null) continue;
  const dKg = (o == null || n == null) ? null : (n - o);
  const dPct = (o == null || n == null || o === 0) ? null : ((n-o)/o*100);
  const dKgStr = dKg == null ? "  —" : (dKg > 0 ? "+" : "") + dKg.toFixed(1);
  const dPctStr = dPct == null ? "  —" : (dPct > 0 ? "+" : "") + dPct.toFixed(1) + "%";
  console.log(`  ${hand}  | ${grip.padEnd(7)} | ${label.padEnd(8)} | ${(o==null?"—":o.toFixed(1)).padStart(6)} | ${(n==null?"—":n.toFixed(1)).padStart(6)} | ${dKgStr.padStart(6)} | ${dPctStr.padStart(7)}`);
  if (dPct != null) maxDrift = Math.max(maxDrift, Math.abs(dPct));
}
console.log(`\nMax |Δ%| in prescribedLoad: ${maxDrift.toFixed(1)}%\n`);

// Empirical-failure-case comparison: simulate "what if last rep 1 was the
// most recent FAILURE point in this scope?"
console.log("EMPIRICAL failure-case (simulated from each scope's most-recent failure rep1)");
console.log("hand | grip    | zone     |  F_act |  T_act | T_targ |   OLD  |   NEW  |   Δkg  |   Δ%");
console.log("-----+---------+----------+--------+--------+--------+--------+--------+--------+--------");
let maxDriftEmp = 0;
for (const grip of GRIPS) for (const hand of HANDS) for (const {label, T} of TARGETS) {
  // Find most recent failure rep1 at exact (hand, grip, target_duration)
  const cand = reps.filter(r => r.hand === hand && r.grip === grip
    && r.target_duration === T && (r.rep_num || 1) === 1
    && r.failed && r.actual_time_s > 0 && effectiveLoad(r) > 0)
    .sort((a,b) => (b.date||"").localeCompare(a.date||""));
  if (cand.length === 0) continue;
  const last = cand[0];
  const F_actual = effectiveLoad(last), T_actual = last.actual_time_s;
  const o = empFailure_OLD(reps, hand, grip, T, F_actual, T_actual);
  const n = empFailure_NEW(reps, hand, grip, T, F_actual, T_actual, priors);
  const dKg = n - o;
  const dPct = o === 0 ? null : (n-o)/o*100;
  const dKgStr = (dKg > 0 ? "+" : "") + dKg.toFixed(1);
  const dPctStr = dPct == null ? "  —" : (dPct > 0 ? "+" : "") + dPct.toFixed(1) + "%";
  console.log(`  ${hand}  | ${grip.padEnd(7)} | ${label.padEnd(8)} | ${F_actual.toFixed(1).padStart(6)} | ${T_actual.toFixed(1).padStart(6)} | ${String(T).padStart(6)} | ${o.toFixed(1).padStart(6)} | ${n.toFixed(1).padStart(6)} | ${dKgStr.padStart(6)} | ${dPctStr.padStart(7)}`);
  if (dPct != null) maxDriftEmp = Math.max(maxDriftEmp, Math.abs(dPct));
}
console.log(`\nMax |Δ%| in empirical failure case: ${maxDriftEmp.toFixed(1)}%`);
