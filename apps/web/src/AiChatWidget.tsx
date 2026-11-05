import { FormEvent, useEffect, useRef, useState } from 'react'
import { api, vnd, type ChatMessage, type Tour } from './api'

type AiChatWidgetProps = {
  onAddToCart: (tourId: number) => void
  allTours?: Tour[]
}

const STORAGE_KEY = 'didau-chat-messages-v1'

const INITIAL_MESSAGE: ChatMessage = {
  id: 'welcome-msg',
  role: 'assistant',
  content: 'Chào bạn! Mình là Trợ lý Cố vấn Hành trình của Đi Đâu. Mình hỗ trợ tư vấn các tour du lịch hiện có trên website Đi Đâu. Bạn đang quan tâm đến điểm đến, thời lượng hay mức ngân sách nào, cứ chia sẻ cùng mình nhé!',
  timestamp: Date.now(),
}

const QUICK_PROMPTS = [
  '🌊 Tour biển đảo dưới 3 triệu',
  '⛰️ Săn mây Tà Xùa hoặc Sa Pa 2N1Đ',
  '🌿 Nghỉ dưỡng an yên cuối tuần',
  '🏮 Trải nghiệm văn hóa Hội An, Huế',
]

export default function AiChatWidget({ onAddToCart, allTours = [] }: AiChatWidgetProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY)
      if (saved) {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed) && parsed.length > 0) return parsed
      }
    } catch {
      // ignore parsing error
    }
    return [INITIAL_MESSAGE]
  })
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [hasUnread, setHasUnread] = useState(false)
  const [addedIds, setAddedIds] = useState<Record<number, boolean>>({})

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages))
    } catch {
      // ignore
    }
  }, [messages])

  useEffect(() => {
    if (isOpen) {
      setHasUnread(false)
      window.setTimeout(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
        inputRef.current?.focus()
      }, 150)
    }
  }, [isOpen])

  useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, busy])

  const sendMessage = async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || busy) return

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: trimmed,
      timestamp: Date.now(),
    }

    const nextMessages = [...messages, userMsg]
    setMessages(nextMessages)
    setInput('')
    setError('')
    setBusy(true)

    try {
      const payload = nextMessages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .slice(-6)
        .map((m) => ({ role: m.role, content: m.content }))

      const res = await api.chat(payload)

      // Map suggested tours from response or fallback to local allTours
      let tours: Tour[] = res.suggestedTours || []
      if ((!tours || tours.length === 0) && res.suggestedTourIds && res.suggestedTourIds.length > 0) {
        tours = allTours.filter((t) => res.suggestedTourIds.includes(t.id))
      }

      const botMsg: ChatMessage = {
        id: `bot-${Date.now()}`,
        role: 'assistant',
        content: res.reply,
        suggestedTours: tours,
        timestamp: Date.now(),
      }

      setMessages((prev) => [...prev, botMsg])
      if (!isOpen) setHasUnread(true)
    } catch (err) {
      setError((err as Error).message || 'Không thể kết nối tới cố vấn AI lúc này. Vui lòng thử lại nhé.')
    } finally {
      setBusy(false)
    }
  }

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    void sendMessage(input)
  }

  const handleClearHistory = () => {
    setMessages([INITIAL_MESSAGE])
    try {
      sessionStorage.removeItem(STORAGE_KEY)
    } catch {
      // ignore
    }
    setError('')
  }

  const handleAddTour = (tourId: number) => {
    onAddToCart(tourId)
    setAddedIds((prev) => ({ ...prev, [tourId]: true }))
    window.setTimeout(() => {
      setAddedIds((prev) => ({ ...prev, [tourId]: false }))
    }, 2000)
  }

  return (
    <div className="ai-chat-root">
      {/* Floating Action Button */}
      <button
        type="button"
        className={`ai-chat-launcher ${isOpen ? 'is-active' : ''}`}
        onClick={() => setIsOpen((prev) => !prev)}
        aria-label={isOpen ? 'Đóng cửa sổ tư vấn AI' : 'Mở trợ lý cố vấn du lịch AI'}
        aria-expanded={isOpen}
      >
        <div className="launcher-inner">
          {isOpen ? (
            <span className="launcher-close-icon">×</span>
          ) : (
            <>
              <span className="launcher-sparkle">✳</span>
              <span className="launcher-label">Hỏi Đi Đâu AI</span>
              {hasUnread && <span className="launcher-unread-dot" />}
            </>
          )}
        </div>
      </button>

      {/* Chat Window Panel */}
      {isOpen && (
        <section className="ai-chat-panel" role="dialog" aria-label="Khung trò chuyện với Đi Đâu AI">
          <header className="ai-chat-header">
            <div className="ai-chat-profile">
              <span className="ai-avatar">Đ</span>
              <div>
                <div className="ai-name-row">
                  <strong>Đi Đâu AI</strong>
                  <span className="ai-badge">Trực tuyến</span>
                </div>
                <small>Cố vấn hành trình bản địa</small>
              </div>
            </div>
            <div className="ai-header-actions">
              <button
                type="button"
                className="ai-action-btn"
                onClick={handleClearHistory}
                title="Xóa lịch sử trò chuyện"
                aria-label="Xóa lịch sử trò chuyện"
              >
                ↺
              </button>
              <button
                type="button"
                className="ai-action-btn ai-close-btn"
                onClick={() => setIsOpen(false)}
                title="Thu nhỏ"
                aria-label="Đóng khung chat"
              >
                ×
              </button>
            </div>
          </header>

          <div className="ai-chat-body">
            <div className="ai-message-list">
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`ai-message-row ${msg.role === 'user' ? 'is-user' : 'is-bot'}`}
                >
                  {msg.role === 'assistant' && <span className="ai-msg-avatar">✳</span>}
                  <div className="ai-message-content">
                    <div className="ai-bubble">
                      <p>{msg.content}</p>
                    </div>

                    {/* Suggested Tours Cards */}
                    {msg.suggestedTours && msg.suggestedTours.length > 0 && (
                      <div className="ai-tour-suggestions">
                        <span className="ai-suggestions-title">HÀNH TRÌNH PHÙ HỢP GỢI Ý CHO BẠN:</span>
                        <div className="ai-tour-cards">
                          {msg.suggestedTours.map((tour) => (
                            <article key={tour.id} className="ai-mini-card">
                              <img
                                src={tour.image}
                                alt={tour.image_alt || tour.title}
                                className="ai-mini-img"
                                loading="lazy"
                              />
                              <div className="ai-mini-info">
                                <span className="ai-mini-location">⌖ {tour.location} · {tour.duration}</span>
                                <h4>{tour.title}</h4>
                                <div className="ai-mini-bottom">
                                  <strong>{vnd(tour.price)}</strong>
                                  <button
                                    type="button"
                                    className={`ai-add-btn ${addedIds[tour.id] ? 'is-added' : ''}`}
                                    onClick={() => handleAddTour(tour.id)}
                                    aria-label={`Thêm ${tour.title} vào chuyến đi`}
                                  >
                                    {addedIds[tour.id] ? 'Đã thêm ✓' : '+ Thêm vào chuyến đi'}
                                  </button>
                                </div>
                              </div>
                            </article>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ))}

              {busy && (
                <div className="ai-message-row is-bot">
                  <span className="ai-msg-avatar">✳</span>
                  <div className="ai-message-content">
                    <div className="ai-bubble ai-typing-bubble">
                      <span className="typing-dot" />
                      <span className="typing-dot" />
                      <span className="typing-dot" />
                    </div>
                  </div>
                </div>
              )}

              {error && (
                <div className="ai-chat-error" role="alert">
                  <span>!</span> {error}
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {/* Quick Prompts */}
            {messages.length <= 2 && !busy && (
              <div className="ai-quick-prompts">
                <span className="ai-quick-label">Gợi ý câu hỏi:</span>
                <div className="ai-chips">
                  {QUICK_PROMPTS.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      className="ai-chip"
                      onClick={() => void sendMessage(prompt)}
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <form className="ai-chat-footer" onSubmit={handleSubmit}>
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Hỏi về điểm đến, ngân sách, số ngày đi..."
              maxLength={400}
              disabled={busy}
              aria-label="Nhập câu hỏi tư vấn du lịch"
            />
            <button
              type="submit"
              className="ai-send-btn"
              disabled={busy || !input.trim()}
              aria-label="Gửi tin nhắn"
            >
              <span>↗</span>
            </button>
          </form>
        </section>
      )}
    </div>
  )
}

