import '../../native-bridge/bootstrap'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/app.css'
import { AvatarMonitorPage } from './pages/AvatarMonitorPage'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AvatarMonitorPage />
  </StrictMode>
)
