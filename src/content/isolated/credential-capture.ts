import {
  DEFAULT_UI_PREFERENCES, UI_PREFERENCES_STORAGE_KEY, parseUiPreferences, resolveUiLocale,
} from '@shared/config/ui-preferences'
import { CREDENTIAL_CAPTURE_CHANNEL, isCredentialCaptureResult, type CredentialCaptureCommand } from '@shared/messaging/credential-capture'
import { CredentialCaptureToast } from './credential-toast'
import {
  CredentialSubmissionObserver, capturePageHasError, capturePageHasPasswordForm, capturePageHasSuccess,
} from './credential-submission'

export function startCredentialCapture(doc: Document, documentId: string) {
  let stopped = false
  let preferences = DEFAULT_UI_PREFERENCES
  const send = async (command: CredentialCaptureCommand): Promise<unknown> => chrome.runtime.sendMessage(command)
  const toast = new CredentialCaptureToast(doc, documentId, send)
  const dispatch = async (command: CredentialCaptureCommand) => {
    try {
      const result = await send(command)
      if (!stopped && isCredentialCaptureResult(result)) toast.show(result)
    } catch { /* Worker restart discards the in-memory submission. */ }
  }
  const observer = new CredentialSubmissionObserver(doc, documentId, (command) => { void dispatch(command) })
  observer.start()
  const resumeTimer = setTimeout(() => {
    void dispatch({ channel: CREDENTIAL_CAPTURE_CHANNEL, documentId, type: 'resume',
      hasPasswordForm: capturePageHasPasswordForm(doc), hasError: capturePageHasError(doc), hasSuccess: capturePageHasSuccess(doc) })
  }, 900)
  const applyPreferences = () => toast.setAppearance(
    resolveUiLocale(preferences.language, chrome.i18n.getUILanguage()), preferences.theme)
  const storageChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local' || !(UI_PREFERENCES_STORAGE_KEY in changes)) return
    preferences = parseUiPreferences(changes[UI_PREFERENCES_STORAGE_KEY]?.newValue)
    applyPreferences()
  }
  chrome.storage.onChanged.addListener(storageChanged)
  void chrome.storage.local.get(UI_PREFERENCES_STORAGE_KEY).then((values) => {
    if (stopped) return
    preferences = parseUiPreferences(values[UI_PREFERENCES_STORAGE_KEY])
    applyPreferences()
  }).catch(() => undefined)
  const dark = doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)')
  const themeChanged = () => toast.systemThemeChanged()
  dark?.addEventListener('change', themeChanged)
  return {
    isOwnedSurface: (element: Element) => toast.isOwnedSurface(element),
    refresh: () => dispatch({ channel: CREDENTIAL_CAPTURE_CHANNEL, type: 'get', documentId }),
    stop() {
      stopped = true
      clearTimeout(resumeTimer)
      observer.stop()
      toast.stop()
      chrome.storage.onChanged.removeListener(storageChanged)
      dark?.removeEventListener('change', themeChanged)
    },
  }
}
