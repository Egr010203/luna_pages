import React from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './App.tsx'

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; message: string }
> {
  state = { hasError: false, message: '' };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, message: error.message };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary] Приложение упало:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 32, fontFamily: 'system-ui', color: '#ff4d6d' }}>
          <h2>Ошибка запуска приложения</h2>
          <p style={{ color: '#666', fontSize: 14 }}>{this.state.message}</p>
          <p style={{ color: '#666', fontSize: 14 }}>Подробности в консоли (F12).</p>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)
