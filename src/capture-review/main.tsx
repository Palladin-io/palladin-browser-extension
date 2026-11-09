import { createRoot } from 'react-dom/client';
import { PopupPreferencesProvider } from '../popup/preferences';
import { CaptureFrameApp } from './App';
import { bindCaptureFrame } from './frame-connection';
import '../popup/popup.css';
import '../popup/redesign.css';
import './frame.css';

const container = document.getElementById('root');
if (!container) throw new Error('Capture frame root missing');
const root = createRoot(container);
const stop = bindCaptureFrame(window,
  () => chrome.runtime.connect({ name: 'palladin.inline-capture-review.frame.v1' }),
  connection => root.render(<PopupPreferencesProvider><CaptureFrameApp connection={connection} /></PopupPreferencesProvider>),
  () => root.render(null));
window.addEventListener('pagehide', stop, { once: true });
