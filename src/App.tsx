import ClientDashboard from './components/ClientDashboard'
import './App.css'

/**
 * Enrollment vs dashboard routing lives in `ClientDashboard`: it calls `getPersistedIdentity()`
 * on mount so a saved `identity.json` shows the dashboard immediately (no WS wait).
 */
function App() {
  return <ClientDashboard />
}

export default App
