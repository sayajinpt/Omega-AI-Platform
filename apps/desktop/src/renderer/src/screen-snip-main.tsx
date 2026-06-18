import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../../native-bridge/bootstrap'
import './styles/app.css'
import { ScreenSnipPage } from './pages/ScreenSnipPage'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ScreenSnipPage />
  </StrictMode>
)
