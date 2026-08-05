import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

/**
 * 全局错误边界：捕获渲染层未处理的异常，展示友好恢复界面而非白屏。
 */
export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, errorInfo)
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null })
    window.location.reload()
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          width: '100vw',
          background: 'var(--color-background, #F6F7F9)',
          color: 'var(--color-foreground, #18191C)',
          fontFamily: 'system-ui, sans-serif',
          gap: '16px',
          padding: '24px',
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: '48px' }}>♪</div>
        <h1 style={{ fontSize: '22px', fontWeight: 700, margin: 0 }}>
          出了一点小问题
        </h1>
        <p style={{ fontSize: '14px', color: 'var(--color-muted-foreground, #61666D)', maxWidth: '420px', margin: 0 }}>
          BiliMusic 遇到了一个意外错误。尝试重新加载页面，如果问题持续出现，请重启应用。
        </p>
        {this.state.error && (
          <details
            style={{
              maxWidth: '600px',
              maxHeight: '200px',
              overflow: 'auto',
              fontSize: '12px',
              color: 'var(--color-muted-foreground, #9499A0)',
              background: 'var(--color-card, #FFFFFF)',
              border: '1px solid var(--color-border, #E3E5E7)',
              borderRadius: '8px',
              padding: '12px',
            }}
          >
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>错误详情</summary>
            <pre style={{ marginTop: '8px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {this.state.error.stack || this.state.error.message}
            </pre>
          </details>
        )}
        <button
          onClick={this.handleReload}
          style={{
            marginTop: '8px',
            padding: '10px 28px',
            borderRadius: '9999px',
            border: 'none',
            background: '#FB7299',
            color: '#FFFFFF',
            fontSize: '14px',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          重新加载
        </button>
      </div>
    )
  }
}
