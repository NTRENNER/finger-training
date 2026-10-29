import React, { useRef, useState } from 'react';
import { C } from '../ui/theme.js';
import { checkFile, uploadPhotos } from './handUpload.js';

// Instructions plus upload for HO device sizing photos. Used in Settings
// (signed-in users, prefix u/<id>) and on the public /hands link (prefix =
// the link's code). `prefix` null means uploads aren't possible here;
// `blockedMessage` says why.

const text = { fontSize: 14, color: C.text, lineHeight: 1.55, margin: '0 0 10px' };
const step = { fontSize: 16, fontWeight: 700, margin: '24px 0 8px', color: C.text };
const num = { color: C.orange, marginRight: 6 };
const callout = { ...text, background: `${C.orange}1a`, borderLeft: `3px solid ${C.orange}`, borderRadius: 6, padding: '10px 12px' };
const row = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, alignItems: 'start' };
const img = { display: 'block', width: '100%', height: 'auto', borderRadius: 8 };
const caption = { color: C.muted, fontSize: 12, textAlign: 'center', marginTop: 4 };
const field = { display: 'grid', gap: 6, fontSize: 14, fontWeight: 600, color: C.text, minWidth: 0 };
const input = { font: 'inherit', width: '100%', padding: '10px 12px', borderRadius: 8, border: `1px solid ${C.border}`, background: C.bg, color: C.text };

function MarkDiagram() {
  const finger = (x, good) => <g key={x}>
    <rect x={x} y="8" width="46" height="128" rx="22" fill="#f1d3c2" stroke={C.muted} />
    {[64, 104].map(y => <g key={y}>
      <line x1={x + 4} y1={y} x2={x + 42} y2={y} stroke="#c9a896" strokeWidth="0.8" />
      {good
        ? <><line x1={x + 1} y1={y} x2={x + 7} y2={y} stroke="#111" strokeWidth="2.4" /><line x1={x + 39} y1={y} x2={x + 45} y2={y} stroke="#111" strokeWidth="2.4" /></>
        : <line x1={x + 1} y1={y} x2={x + 45} y2={y} stroke="#111" strokeWidth="3.4" />}
    </g>)}
    <text x={x + 23} y="160" textAnchor="middle" fontWeight="700" fontSize="13" fill={good ? C.green : C.red}>{good ? 'YES' : 'NO'}</text>
  </g>;
  return <svg viewBox="0 0 180 170" style={img} role="img" aria-label="Yes: small marks at each edge. No: a line across the finger.">
    {finger(25, true)}{finger(109, false)}
  </svg>;
}

export function HandPhotoUpload({ client, prefix, blockedMessage, defaultName = '' }) {
  const formRef = useRef(null);
  const [name, setName] = useState(defaultName);
  const [status, setStatus] = useState({ message: '', kind: '' });
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    const form = formRef.current;
    const together = form.elements.together.files[0];
    const apart = form.elements.apart.files[0];
    const problem = (!name.trim() && 'Enter your name.')
      || checkFile(together, 'fingers-together') || checkFile(apart, 'fingers-apart');
    if (problem) { setStatus({ message: problem, kind: 'error' }); return; }
    setBusy(true);
    setStatus({ message: 'Uploading…', kind: '' });
    try {
      await uploadPhotos(client, { prefix, name: name.trim(), together, apart });
      form.reset();
      setStatus({ message: 'Thank you! Both photos arrived.', kind: 'ok' });
    } catch (error) {
      setStatus({ message: error.message, kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  return <div>
    <p style={{ ...text, color: C.muted }}>You need a thin black pen, a bank card, a sheet of white paper and your phone. Measure the hand you train with.</p>

    <h3 style={step}><span style={num}>1.</span>Mark the creases: small marks at the edges only</h3>
    <p style={callout}>Use a <b>thin</b> pen. Make a <b>small mark (about 1/8 inch)</b> at <b>each edge</b> of the finger, where the crease ends. <b>Do not draw a line across the finger.</b></p>
    <p style={text}>On the index, middle, ring and little finger, mark the crease at the <b>middle joint</b> and the crease at the <b>end joint</b>. Skip the thumb. That's <b>16 small marks</b>.</p>
    <div style={row}>
      <figure style={{ margin: 0 }}><MarkDiagram /></figure>
      <figure style={{ margin: 0 }}>
        <img src="/hands/marks-example.jpg" alt="A marked hand: two small marks on each crease" width="700" height="730" style={img} />
        <figcaption style={caption}>16 small marks</figcaption>
      </figure>
    </div>

    <h3 style={step}><span style={num}>2.</span>Set up</h3>
    <ul style={{ ...text, paddingLeft: 20 }}>
      <li>White paper on a table, with bright light from <b>one side</b> (a window or lamp), not direct sun.</li>
      <li>Card <b>flat</b> on the paper beside your fingers, fully in view and <b>not touching</b> your hand.</li>
      <li>Palm up, fingers straight, with the <b>fingertips resting flat on the paper</b>.</li>
    </ul>

    <h3 style={step}><span style={num}>3.</span>Take two photos with the 2× lens</h3>
    <p style={callout}>Tap <b>2×</b> in the camera app (not 1×) and hold the phone about <b>18 inches</b> above your hand, straight down, with your fingers near the <b>middle of the frame</b>. A close-up with the 1× lens can make fingertips measure up to 1/8 inch too long.</p>
    <div style={row}>
      <figure style={{ margin: 0 }}>
        <img src="/hands/photo-together.jpg" alt="Fingers together, card beside the hand" width="900" height="674" style={img} />
        <figcaption style={caption}>Photo 1: fingers together</figcaption>
      </figure>
      <figure style={{ margin: 0 }}>
        <img src="/hands/photo-apart.jpg" alt="Fingers slightly apart" width="700" height="929" style={img} />
        <figcaption style={caption}>Photo 2: fingers slightly apart</figcaption>
      </figure>
    </div>

    <h3 style={step}><span style={num}>4.</span>Upload them here</h3>
    {prefix ? <>
      <p style={text}>Choose the photos straight from your photo library so the originals are sent, not screenshots.</p>
      <form ref={formRef} onSubmit={submit} noValidate style={{ display: 'grid', gap: 16 }}>
        <label style={field}>Your name
          <input type="text" name="name" autoComplete="name" value={name} onChange={e => setName(e.target.value)} style={input} />
        </label>
        <label style={field}>Photo 1: fingers together
          <input type="file" name="together" accept="image/*,.heic,.heif" style={{ font: 'inherit', fontWeight: 400, width: '100%' }} />
        </label>
        <label style={field}>Photo 2: fingers slightly apart
          <input type="file" name="apart" accept="image/*,.heic,.heif" style={{ font: 'inherit', fontWeight: 400, width: '100%' }} />
          <span style={{ color: C.muted, fontSize: 12, fontWeight: 400 }}>Only you and the person measuring your hand can see these photos.</span>
        </label>
        <button type="submit" disabled={busy} style={{
          font: 'inherit', fontWeight: 700, width: '100%', padding: 12, border: 0, borderRadius: 8,
          background: C.orange, color: '#fff', cursor: busy ? 'progress' : 'pointer', opacity: busy ? 0.6 : 1,
        }}>Upload photos</button>
      </form>
      <p role="status" aria-live="polite" style={{
        ...text, marginTop: 12, minHeight: '1.5em', fontWeight: status.kind === 'ok' ? 700 : 400,
        color: status.kind === 'ok' ? C.green : status.kind === 'error' ? C.red : C.muted,
      }}>{status.message}</p>
    </> : <p style={{ ...text, color: C.muted }}>{blockedMessage}</p>}
  </div>;
}
