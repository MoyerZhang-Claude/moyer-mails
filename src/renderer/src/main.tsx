import { createRoot } from 'react-dom/client'
import { App } from './components/App'
import { setupNative } from './native'
import './styles.css'

setupNative()
createRoot(document.getElementById('root')!).render(<App />)
