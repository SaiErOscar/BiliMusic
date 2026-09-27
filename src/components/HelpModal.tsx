import { useEffect } from 'react'
import { X, BookOpen } from 'lucide-react'
import { getHelpContent, resolveHelpLang } from '@/utils/helpContent'

interface HelpModalProps {
  onClose: () => void
}

/**
 * 内置使用说明弹窗。文案来自 helpContent，按当前语言取数（本地化）。
 * 交互：点击遮罩或右上角关闭，Esc 关闭；正文超高度时内部滚动。
 */
export default function HelpModal({ onClose }: HelpModalProps) {
  const content = getHelpContent(resolveHelpLang())

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="help-modal-backdrop" onClick={onClose}>
      <div
        className="help-modal"
        role="dialog"
        aria-modal="true"
        aria-label={content.title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="help-modal__head">
          <div className="help-modal__title">
            <p>
              <BookOpen size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
              {content.subtitle}
            </p>
            <h2>{content.title}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </div>

        <div className="help-modal__body">
          {content.sections.map((section) => (
            <section className="help-modal__section" key={section.title}>
              <h3>{section.title}</h3>
              <ul>
                {section.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          ))}
          <p className="help-modal__footer">{content.footer}</p>
        </div>
      </div>
    </div>
  )
}
