import { useEffect, useState } from 'react'
import { useI18n, type TranslationKey } from '../i18n'

const WELCOME_MESSAGE_KEYS: readonly TranslationKey[] = [
  'auth.welcomeLine1',
  'auth.welcomeLine2',
  'auth.welcomeLine3',
  'auth.welcomeLine4',
]

export function RotatingWelcome() {
  const { t } = useI18n()
  const [index, setIndex] = useState(0)
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let fadeTimeout: ReturnType<typeof setTimeout> | undefined
    const id = setInterval(() => {
      setVisible(false)
      fadeTimeout = setTimeout(() => {
        setIndex((prev) => (prev + 1) % WELCOME_MESSAGE_KEYS.length)
        setVisible(true)
      }, 350)
    }, 3800)
    return () => {
      clearInterval(id)
      clearTimeout(fadeTimeout)
    }
  }, [])

  return (
    <p
      className="auth-brand-tagline"
      style={{ opacity: visible ? 1 : 0 }}
    >
      {t(WELCOME_MESSAGE_KEYS[index]!)}
    </p>
  )
}

