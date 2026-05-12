import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      const e = this.state.error
      return (
        <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif', maxWidth: 720 }}>
          <h1 style={{ fontSize: '1.25rem' }}>画面の表示中にエラーが発生しました</h1>
          <p style={{ color: '#444' }}>再読み込みするか、開発者ツール（F12）の Console も併せてご確認ください。</p>
          <pre
            style={{
              marginTop: 16,
              padding: 12,
              background: '#f5f5f5',
              overflow: 'auto',
              fontSize: 13,
              borderRadius: 6,
            }}
          >
            {String(e?.message ?? e)}
            {e?.stack ? `\n\n${e.stack}` : ''}
          </pre>
        </div>
      )
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
