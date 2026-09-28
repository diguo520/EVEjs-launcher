import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { LocaleProvider } from './components/shell/locale-provider'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* 语言提供者放在最外层：App 自己的 hooks（环境自检等）也要能取到当前语言 */}
    <LocaleProvider>
      <App />
    </LocaleProvider>
  </StrictMode>,
)
