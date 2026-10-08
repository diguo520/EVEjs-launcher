import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { LocaleProvider } from './components/shell/locale-provider'
import { FALLBACK_LOCALE, loadCatalog, readStoredLocale } from './lib/i18n'

async function bootstrap() {
  let locale = readStoredLocale()
  try {
    await loadCatalog(locale)
  } catch {
    // 本地 chunk 损坏时退回英文；英文也读不到就回中文源语言，至少不白屏。
    locale = FALLBACK_LOCALE
    try {
      await loadCatalog(locale)
    } catch {
      locale = "zh"
    }
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      {/* 语言提供者放在最外层：App 自己的 hooks（环境自检等）也要能取到当前语言 */}
      <LocaleProvider initialLocale={locale}>
        <App />
      </LocaleProvider>
    </StrictMode>,
  )
}

void bootstrap()
