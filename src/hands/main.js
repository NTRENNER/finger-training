// Entry for the public /hands page: the same instructions and upload as the
// Settings section, for people without an app account. Uploads need the
// code in the link (?c=...).
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { createClient } from '@supabase/supabase-js';
import { base } from '../ui/theme.js';
import { HandPhotoUpload } from './HandPhotoUpload.jsx';
import { uploadCode } from './handUpload.js';

const url = process.env.REACT_APP_SUPABASE_URL;
const key = process.env.REACT_APP_SUPABASE_ANON_KEY;
const client = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
const code = client ? uploadCode(window.location.search) : null;

Object.assign(document.body.style, base);
createRoot(document.getElementById('root')).render(
  createElement('main', { style: { maxWidth: 560, margin: '0 auto', padding: '28px 16px 48px' } },
    createElement('h1', { style: { fontSize: 26, lineHeight: 1.2, margin: '0 0 8px' } }, 'Measuring your hand for the HO Micro'),
    createElement(HandPhotoUpload, {
      client, prefix: code,
      blockedMessage: 'To upload, use the full link you were sent.',
    })),
);
