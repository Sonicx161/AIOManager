import './lib/polyfill'
import { StrictMode } from 'react'
import ReactDOM from 'react-dom/client'

// --- EMERGENCY DEBUG TRAP ---
// Catches specific JSON errors that are hard to trace
window.addEventListener('error', (event) => {
  if (event.message.includes('valid JSON') || event.message.includes('object Object')) {
    document.body.innerHTML = `
      <div style="background:red; color:white; padding:20px; font-family:monospace; white-space:pre-wrap;">
        <h1>CRITICAL JSON ERROR TRAPPED</h1>
        <h2>${event.message}</h2>
        <hr/>
        <strong>Filename:</strong> ${event.filename}<br/>
        <strong>Line:</strong> ${event.lineno}:${event.colno}<br/>
        <hr/>
        <strong>Stack:</strong><br/>
        ${event.error?.stack || 'No stack trace available'}
      </div>
    `
  }
})

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason?.message || String(event.reason)
  if (reason.includes('valid JSON') || reason.includes('object Object')) {
    document.body.innerHTML = `
      <div style="background:darkred; color:white; padding:20px; font-family:monospace; white-space:pre-wrap;">
        <h1>UNHANDLED PROMISE REJECTION TRAPPED</h1>
        <h2>${reason}</h2>
        <hr/>
        <strong>Stack:</strong><br/>
        ${event.reason?.stack || 'No stack trace available'}
      </div>
    `
  }
})

// --- CONSOLE INTERCEPT ---
const originalError = console.error
console.error = (...args) => {
  originalError.apply(console, args)
  const msg = args.map(a => String(a)).join(' ')
  if (msg.includes('valid JSON') || msg.includes('object Object')) {
    document.body.innerHTML += `
        <div style="background:orange; color:black; padding:10px; font-family:monospace; margin-top:10px; border:2px solid black;">
            <h3>CONSOLE ERROR INTERCEPTED</h3>
            ${msg}
        </div>`
  }
}
// ----------------------------

import { BrowserRouter } from 'react-router-dom'
import { ThemeProvider } from './contexts/ThemeContext'
import App from './App.tsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </BrowserRouter>
  </StrictMode>
)
