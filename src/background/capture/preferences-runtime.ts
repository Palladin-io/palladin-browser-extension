import { CapturePreferenceStore } from './preferences'

export const capturePreferences = new CapturePreferenceStore({
  get: (keys) => chrome.storage.local.get(keys),
  set: (values) => chrome.storage.local.set(values),
})
