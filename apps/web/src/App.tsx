import { FormEvent, MouseEvent, useEffect, useMemo, useState } from 'react'
import { api, vnd, type Cart, type OrderLookupResult, type Tour } from './api'
import AdminPanel from './AdminPanel'
import AiChatWidget from './AiChatWidget'

const emptyCart: Cart = { items: [], total: 0, count: 0 }
const dateInAWeek = () => {
  const date = new Date()
  date.setDate(date.getDate() + 7)
  return date.toISOString().slice(0, 10)
}
const faqs = [
  {
    question: 'Tôi nên đặt tour trước bao lâu? Đi một mình có ghép đoàn được không?',
    answer: 'Bạn nên đặt trước từ 3–5 ngày; dịp cuối tuần hoặc lễ Tết nên đặt sớm hơn để có thêm lựa chọn. Các chuyến đi theo nhóm nhỏ, và khách đi một mình luôn được chào đón. Thông tin ghép đoàn cụ thể tùy từng hành trình.',
  },
  {
    question: 'Quy trình đặt chỗ và thanh toán diễn ra như thế nào?',
    answer: 'Thêm hành trình vào mục Chuyến đi, chọn ngày khởi hành và điền thông tin liên hệ để gửi yêu cầu. Bạn có thể chọn thanh toán sau hoặc thanh toán demo; thanh toán demo chỉ mô phỏng trải nghiệm và không thu tiền thật.',
  },
  {
    question: 'Nếu cần hủy chuyến hoặc thay đổi lịch thì sao?',
    answer: 'Điều kiện đổi hoặc hủy có thể khác nhau theo từng hành trình và thời điểm khởi hành. Vui lòng kiểm tra điều kiện áp dụng trước khi xác nhận đặt chỗ; trang đặt tour hiện chưa hiển thị chính sách hoàn tiền chung.',
  },
  {
    question: 'Người lớn tuổi và trẻ nhỏ có phù hợp tham gia không?',
    answer: 'Mức độ vận động và điều kiện tham gia tùy từng chuyến. Hãy xem kỹ thời lượng, điểm đến và nội dung hành trình; nếu đi cùng trẻ nhỏ hoặc người cần hỗ trợ, nên cân nhắc mức độ phù hợp trước khi đặt.',
  },
  {
    question: 'Giá tour đã bao gồm những dịch vụ nào?',
    answer: 'Các dịch vụ bao gồm được ghi riêng trong thông tin của từng hành trình. Bạn có thể xem mục này trên thẻ tour và kiểm tra lại các chi tiết cụ thể trước khi đặt.',
  },
]

export default function App() {
  const [tours, setTours] = useState<Tour[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [cart, setCart] = useState<Cart>(emptyCart)
  const [search, setSearch] = useState('')
  const [submittedSearch, setSubmittedSearch] = useState('')
  const [category, setCategory] = useState('')
  const [sort, setSort] = useState('recommended')
  const [maxPrice, setMaxPrice] = useState(10000000)
  const [cartOpen, setCartOpen] = useState(false)
  const [checkoutOpen, setCheckoutOpen] = useState(false)
  const [adminOpen, setAdminOpen] = useState(false)
  const [lookupOpen, setLookupOpen] = useState(false)
  const [lookupResults, setLookupResults] = useState<OrderLookupResult[]>([])
  const [lookupError, setLookupError] = useState('')
  const [lookupBusy, setLookupBusy] = useState(false)
  const [lookupType, setLookupType] = useState<'orderNumber' | 'email' | 'phone'>('orderNumber')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [booking, setBooking] = useState<{
    orderNumber: string
    total: number
    paymentStatus: 'unpaid' | 'paid'
  } | null>(null)

  useEffect(() => {
    Promise.all([api.tours(), api.categories(), api.cart()])
      .then(([tourData, categoryData, currentCart]) => {
        setTours(tourData)
        setCategories(categoryData)
        setCart(currentCart)
      })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    const filters = { q: submittedSearch, category, sort, maxPrice }
    api.tours(filters)
      .then(setTours)
      .catch((reason: Error) => setError(reason.message))
  }, [submittedSearch, category, sort, maxPrice])

  const run = (action: Promise<Cart>, message?: string) =>
    action.then((nextCart) => {
      setCart(nextCart)
      if (message) {
        setNotice(message)
        window.setTimeout(() => setNotice(''), 2400)
      }
    }).catch((reason: Error) => setError(reason.message))

  const featured = useMemo(() => tours.filter((tour) => tour.featured === 1), [tours])

  const submitSearch = (event: FormEvent) => {
    event.preventDefault()
    setSubmittedSearch(search.trim())
    document.getElementById('discover')?.scrollIntoView({ behavior: 'smooth' })
  }

  const submitOrderLookup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setLookupBusy(true)
    setLookupError('')
    setLookupResults([])
    try {
      const results = await api.lookupOrders(
        lookupType,
        String(form.get('lookupValue')),
      )
      setLookupResults(results)
    } catch (reason) {
      setLookupError((reason as Error).message)
    } finally {
      setLookupBusy(false)
    }
  }

  const openOrderLookup = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    setLookupError('')
    setLookupResults([])
    setLookupOpen(true)
  }

  const selectDestination = (location: string) => {
    setSearch(location)
    setSubmittedSearch(location)
    setCategory('')
    setSort('recommended')
    setMaxPrice(10000000)
    document.getElementById('discover')?.scrollIntoView({ behavior: 'smooth' })
  }

  const placeOrder = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    try {
      const result = await api.order({
        name: String(form.get('name')),
        email: String(form.get('email')),
        phone: String(form.get('phone')),
        departureDate: String(form.get('departureDate')),
        paymentDemo: form.get('paymentMethod') === 'demo',
      })
      setBooking({
        orderNumber: result.orderNumber,
        total: result.total,
        paymentStatus: result.paymentStatus,
      })
      setCheckoutOpen(false)
      setCartOpen(false)
      setCart(emptyCart)
    } catch (reason) {
      setError((reason as Error).message)
    }
  }

  return (
    <>
      <header className="site-header">
        <a className="brand" href="#" aria-label="Đi Đâu về trang chủ">
          <span className="brand-mark">Đ</span>
          <span>điđâu<span className="brand-dot">.</span></span>
        </a>
        <nav className="main-nav" aria-label="Điều hướng chính">
          <a href="#discover">Khám phá</a>
          <a href="#why-us">Về chúng tôi</a>
          <a href="#stories">Cảm hứng</a>
          <a href="#faq">Hỏi đáp</a>
          <a href="#order-lookup" onClick={openOrderLookup}>Tra cứu</a>
        </nav>
        <div className="header-actions">
          <button className="admin-link" onClick={() => setAdminOpen(true)}>Quản trị</button>
          <button className="cart-button" onClick={() => setCartOpen(true)} aria-label="Mở giỏ đặt chỗ">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h2l2.2 11.1a2 2 0 0 0 2 1.6h8.5a2 2 0 0 0 1.9-1.4L22 8H6M10 21h.01M18 21h.01" /></svg>
            <span>Chuyến đi</span>
            {cart.count > 0 && <b className="cart-count">{cart.count}</b>}
          </button>
        </div>
      </header>

      <main>
        <section className="hero">
          <div className="hero-image" role="img" aria-label="Núi non Việt Nam trong ánh nắng sớm" />
          <div className="hero-shade" />
          <div className="hero-content">
            <div className="eyebrow hero-eyebrow"><span /> ĐI ĐÂU CŨNG CÓ CHUYỆN HAY</div>
            <h1>Đi để thấy<br /><em>mình rộng lớn.</em></h1>
            <p>Những hành trình được chọn lọc kỹ càng, để mỗi chuyến đi là một câu chuyện đáng nhớ.</p>
            <a className="hero-link" href="#discover">Tìm hành trình của bạn <span>↘</span></a>
          </div>
          <div className="hero-note"><span>01 — 08</span><i /> Việt Nam, theo một cách khác</div>
          <div className="hero-badge"><span>✳</span><div>Đi chậm hơn.<br /><strong>Nhớ lâu hơn.</strong></div></div>
        </section>

        <form className="search-panel" onSubmit={submitSearch}>
          <label className="search-field">
            <span className="field-icon">⌕</span>
            <span className="search-label">Bạn muốn đi đâu?</span>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Thử “Hà Giang” hoặc “biển đảo”" />
          </label>
          <div className="search-divider" />
          <label className="select-field">
            <span className="field-icon">⌖</span>
            <span className="search-label">Trải nghiệm</span>
            <select value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="">Tất cả phong cách</option>
              {categories.map((item) => <option key={item}>{item}</option>)}
            </select>
          </label>
          <button className="search-submit" type="submit"><span>Khám phá</span><b>↗</b></button>
        </form>

        <section className="intro-row" id="discover">
          <div><div className="eyebrow"><span /> LỰA CHỌN CỦA ĐIĐÂU</div><h2>Chuyến đi đáng để <em>mong chờ.</em></h2></div>
          <p>Không cần đi thật xa. Chỉ cần đi theo cách khiến bạn thấy gần với chính mình hơn.</p>
        </section>

        <section className="discover-section">
          <div className="filters">
            <div className="category-pills">
              <button className={!category ? 'pill active' : 'pill'} onClick={() => setCategory('')}>Tất cả</button>
              {categories.map((item) => (
                <button className={category === item ? 'pill active' : 'pill'} key={item} onClick={() => setCategory(item)}>{item}</button>
              ))}
            </div>
            <div className="filter-controls">
              <label className="price-filter">Ngân sách <span>{vnd(maxPrice)}</span>
                <input type="range" min="1000000" max="10000000" step="500000" value={maxPrice} onChange={(event) => setMaxPrice(Number(event.target.value))} aria-label="Lọc ngân sách tối đa" />
              </label>
              <label className="sort-filter">Sắp xếp
                <select value={sort} onChange={(event) => setSort(event.target.value)}>
                  <option value="recommended">Đề xuất</option>
                  <option value="rating">Đánh giá cao</option>
                  <option value="price-low">Giá thấp trước</option>
                  <option value="price-high">Giá cao trước</option>
                </select>
              </label>
            </div>
          </div>

          {error && <div className="inline-error" role="alert">{error}<button onClick={() => setError('')} aria-label="Đóng thông báo">×</button></div>}
          {notice && <div className="toast" role="status">{notice}</div>}
          {loading ? <div className="loading-state">Đang tìm những hành trình thật hay…</div> : tours.length === 0 ? (
            <div className="empty-results"><span>◌</span><h3>Chưa tìm thấy chuyến đi phù hợp</h3><p>Thử đổi điểm đến hoặc nới ngân sách một chút nhé.</p><button className="outline-button" onClick={() => { setCategory(''); setSearch(''); setSubmittedSearch(''); setMaxPrice(10000000) }}>Xóa bộ lọc</button></div>
          ) : (
            <div className="tour-grid">
              {tours.map((tour, index) => <TourCard key={tour.id} tour={tour} index={index} onAdd={() => run(api.add(tour.id), 'Đã thêm vào chuyến đi của bạn')} />)}
            </div>
          )}
          {featured.length > 0 && !submittedSearch && !category && (
            <div className="collection-note"><span>ĐƯỢC YÊU THÍCH NHẤT</span><p>{featured.slice(0, 3).map((tour) => tour.location).join('　·　')}</p></div>
          )}
        </section>

        <section className="manifesto" id="why-us">
          <div className="manifesto-image"><img src="https://images.unsplash.com/photo-1470770841072-f978cf4d019e?auto=format&fit=crop&w=1200&q=85" alt="Mặt hồ tĩnh lặng giữa núi rừng" loading="lazy" /><span>CHUYỆN ĐƯỜNG XA, NGƯỜI BẢN ĐỊA KỂ</span></div>
          <div className="manifesto-copy">
            <div className="eyebrow"><span /> KHÔNG CHỈ LÀ MỘT CHUYẾN ĐI</div>
            <h2>Đi như người<br /><em>bản địa.</em></h2>
            <p>Chúng tôi tin những khoảnh khắc đẹp nhất không nằm trong lịch trình dày đặc. Chúng nằm ở quán ăn nhỏ người địa phương mách, con đường chưa kịp đặt tên, và câu chuyện kể mãi không xong.</p>
            <div className="manifesto-stats"><div><strong>32<span>+</span></strong><small>trải nghiệm tuyển chọn</small></div><div><strong>4.9<span>/5</span></strong><small>đánh giá từ người đi</small></div><div><strong>100<span>%</span></strong><small>cùng người bản địa</small></div></div>
            <a className="text-link" href="#stories">Đọc câu chuyện của chúng tôi <span>↗</span></a>
          </div>
        </section>

        <section className="quote-section" id="stories">
          <div className="quote-mark">“</div>
          <blockquote>“Hà Giang đẹp lắm, nhưng điều mình nhớ nhất lại là bữa cơm tối cùng gia đình anh dẫn đường.”</blockquote>
          <div className="quote-credit"><span className="avatar">Đ</span><div><strong>Đặng Thị Ánh Dương</strong><small>Chuyến đi Hà Giang · Tháng 10, 2025</small></div></div>
          <div className="quote-index">MỘT CÂU CHUYỆN TRONG HÀNG NGÀN</div>
        </section>

        <section className="faq-section" id="faq">
          <div className="faq-heading">
            <div className="eyebrow"><span /> CÂU HỎI THƯỜNG GẶP</div>
            <h2>Những điều bạn <em>quan tâm trước khi đi.</em></h2>
            <p>Giải đáp nhanh những thắc mắc phổ biến về hành trình và đặt chỗ.</p>
          </div>
          <div className="faq-list">
            {faqs.map(({ question, answer }, index) => (
              <details className="faq-item" key={question} open={index === 0}>
                <summary>{question}<span className="faq-toggle" aria-hidden="true" /></summary>
                <p>{answer}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="newsletter">
          <div><span className="eyebrow">THƯ TỪ NHỮNG NẺO ĐƯỜNG</span><h2>Chuyện hay, gửi bạn<br /><em>mỗi tháng một lần.</em></h2></div>
          <form onSubmit={async (event) => {
            event.preventDefault()
            const form = event.currentTarget
            const email = String(new FormData(form).get('email'))
            try {
              await api.subscribe(email)
              setNotice('Bạn đã đăng ký nhận thư thành công!')
              form.reset()
              window.setTimeout(() => setNotice(''), 3000)
            } catch (reason) {
              setError((reason as Error).message)
            }
          }}>
            <label htmlFor="newsletter-email">Địa chỉ email</label>
            <div className="newsletter-input"><input id="newsletter-email" type="email" placeholder="tenban@email.com" required /><button aria-label="Đăng ký nhận thư">↗</button></div>
            <small>Không thư rác. Chỉ có cảm hứng lên đường.</small>
          </form>
        </section>
      </main>

      <footer className="site-footer">
        <div className="footer-main">
          <section className="footer-about">
            <a className="brand footer-brand" href="#" aria-label="Đi Đâu về đầu trang"><span className="brand-mark">Đ</span><span>điđâu<span className="brand-dot">.</span></span></a>
            <p className="footer-tagline">Đi chậm hơn. Nhớ lâu hơn.</p>
            <p className="footer-description">Nền tảng du lịch trải nghiệm bản địa tuyển chọn tại Việt Nam. Kết nối những tâm hồn yêu thiên nhiên và văn hóa cùng người dẫn đường bản xứ.</p>
            <a className="live-site-link" href="https://didau-travel.anhduong34205.workers.dev/" target="_blank" rel="noreferrer">Mở website trực tuyến ↗</a>
          </section>
          <section className="footer-column">
            <h2>ĐIỂM ĐẾN TIÊU BIỂU</h2>
            <ul>
              {['Hà Giang', 'Quảng Nam', 'Kiên Giang', 'Lào Cai', 'Ninh Bình', 'Cần Thơ'].map((location) => (
                <li key={location}><a href="#discover" onClick={() => selectDestination(location)}>{location}</a></li>
              ))}
            </ul>
          </section>
          <section className="footer-column">
            <h2>HỖ TRỢ &amp; CHÍNH SÁCH</h2>
            <ul>
              <li><a href="#faq">Chính sách hoàn hủy tour</a></li>
              <li><a href="#faq">Bảo hiểm du lịch 50 triệu</a></li>
              <li><a href="#faq">Điều khoản dịch vụ</a></li>
              <li><a href="#faq">Chính sách bảo mật</a></li>
              <li><a href="#faq">Câu hỏi thường gặp (FAQ)</a></li>
              <li><a href="#order-lookup" onClick={openOrderLookup}>Tra cứu đơn đặt chỗ</a></li>
            </ul>
          </section>
          <section className="footer-column footer-support">
            <h2>LIÊN HỆ &amp; HỖ TRỢ</h2>
            <address className="footer-contact-details">
              <p><strong>Hotline tư vấn:</strong> <a className="footer-hotline" href="tel:19006868">1900 6868</a> <span>(8h – 21h)</span></p>
              <p><strong>Email:</strong> <a href="mailto:chao@didau.vn">chao@didau.vn</a></p>
              <p><strong>Hà Nội:</strong> 12 Tràng Thi, Hoàn Kiếm</p>
              <p><strong>TP.HCM:</strong> 45 Lê Duẩn, Quận 1</p>
            </address>
            <div className="footer-badges"><span>VietQR</span><span>Napas 247</span><span>Chuyển khoản</span></div>
          </section>
        </div>
        <div className="footer-bottom">
          <span>© 2026 ĐIĐÂU TRAVEL · ĐI CHẬM HƠN, NHỚ LÂU HƠN</span>
          <div className="footer-trust-items">
            <span>✓ 100% Người bản địa</span>
            <span>✓ Bảo hiểm trọn gói</span>
            <span>✓ Thanh toán VietQR an toàn</span>
          </div>
        </div>
      </footer>

      {lookupOpen && <div className="modal-backdrop order-lookup-backdrop" onClick={() => setLookupOpen(false)}>
        <section className="order-lookup-modal" role="dialog" aria-modal="true" aria-labelledby="order-lookup-title" onClick={(event) => event.stopPropagation()}>
          <button className="icon-button modal-close" onClick={() => setLookupOpen(false)} aria-label="Đóng tra cứu">×</button>
          <div className="order-lookup-heading">
            <div className="eyebrow"><span /> TRA CỨU ĐƠN ĐẶT CHỖ</div>
            <h2 id="order-lookup-title">Chuyến đi của bạn<br /><em>đang ở đâu?</em></h2>
            <p>Tra cứu đơn đặt chỗ bằng một trong ba thông tin: mã đơn, email hoặc số điện thoại đã dùng khi đặt.</p>
          </div>
          <div className="order-lookup-content">
            <form className="order-lookup-form" onSubmit={submitOrderLookup}>
              <label>Tra cứu bằng
                <select value={lookupType} onChange={(event) => setLookupType(event.target.value as 'orderNumber' | 'email' | 'phone')}>
                  <option value="orderNumber">Mã đơn đặt chỗ</option>
                  <option value="email">Email</option>
                  <option value="phone">Số điện thoại</option>
                </select>
              </label>
              <label>{lookupType === 'orderNumber' ? 'Mã đơn đặt chỗ' : lookupType === 'email' ? 'Email đã dùng khi đặt' : 'Số điện thoại đã dùng khi đặt'}
                <input
                  key={lookupType}
                  name="lookupValue"
                  type={lookupType === 'email' ? 'email' : lookupType === 'phone' ? 'tel' : 'text'}
                  required
                  maxLength={lookupType === 'email' ? 254 : lookupType === 'phone' ? 30 : 40}
                  placeholder={lookupType === 'orderNumber' ? 'Ví dụ: VT-2026-ABC123' : lookupType === 'email' ? 'ban@email.com' : 'Ví dụ: 090 123 4567'}
                  autoCapitalize={lookupType === 'orderNumber' ? 'characters' : 'none'}
                  autoComplete={lookupType === 'email' ? 'email' : lookupType === 'phone' ? 'tel' : 'off'}
                />
              </label>
              {lookupError && <p className="form-error" role="alert">{lookupError}</p>}
              <button className="button-dark full-button" disabled={lookupBusy}>{lookupBusy ? 'Đang tra cứu…' : 'Tra cứu đơn đặt chỗ'} <span>↗</span></button>
            </form>
            {lookupResults.map((lookupResult) => <article className="order-lookup-result" role="status" key={lookupResult.order_number}>
                <div className="order-lookup-result-head"><span>ĐƠN ĐẶT CHỖ</span><strong>{lookupResult.order_number}</strong></div>
                <p>{lookupResult.items || 'Chuyến đi'} · Khởi hành {new Intl.DateTimeFormat('vi-VN').format(new Date(`${lookupResult.departure_date}T00:00:00`))}</p>
                <div className="order-lookup-result-details">
                  <span className={`status status-${lookupResult.status}`}>{lookupResult.status === 'pending' ? 'Chờ xác nhận' : lookupResult.status === 'confirmed' ? 'Đã xác nhận' : 'Đã hủy'}</span>
                  <span className={`payment-status payment-${lookupResult.payment_status}`}><i aria-hidden="true" />{lookupResult.payment_status === 'paid' ? 'Đã thanh toán · Demo' : 'Chưa thanh toán'}</span>
                  <strong>{vnd(lookupResult.total)}</strong>
                </div>
              </article>)}
          </div>
        </section>
      </div>}

      {cartOpen && <div className="backdrop" onClick={() => setCartOpen(false)} />}
      <aside className={`cart-drawer ${cartOpen ? 'is-open' : ''}`} aria-hidden={!cartOpen}>
        <div className="drawer-heading"><div><span className="eyebrow">LỊCH TRÌNH CỦA BẠN</span><h2>Chuyến đi <span>({cart.count})</span></h2></div><button className="icon-button" onClick={() => setCartOpen(false)} aria-label="Đóng giỏ hàng">×</button></div>
        <div className="drawer-content">
          {cart.items.length === 0 ? <div className="empty-cart"><span>✳</span><h3>Chưa có chuyến nào</h3><p>Hành trình đáng nhớ tiếp theo đang đợi bạn chọn.</p><button className="outline-button" onClick={() => setCartOpen(false)}>Khám phá ngay</button></div> : cart.items.map(({ tour, qty }) => (
            <div className="cart-line" key={tour.id}><img src={tour.image} alt="" /><div className="cart-line-info"><strong>{tour.title}</strong><span>{tour.location} · {tour.duration}</span><b>{vnd(tour.price)}</b><div className="quantity"><button onClick={() => run(api.setQty(tour.id, qty - 1))} aria-label="Giảm số khách">−</button><span>{qty} khách</span><button onClick={() => run(api.setQty(tour.id, qty + 1))} aria-label="Tăng số khách" disabled={qty >= 10}>+</button></div></div><button className="remove-line" onClick={() => run(api.setQty(tour.id, 0))} aria-label={`Xóa ${tour.title}`}>×</button></div>
          ))}
        </div>
        {cart.count > 0 && <div className="drawer-footer"><div className="total-row"><span>Tạm tính</span><strong>{vnd(cart.total)}</strong></div><p>Đặt lịch trước · Thanh toán demo hoặc sau</p><button className="button-dark full-button" onClick={() => setCheckoutOpen(true)}>Đặt chuyến đi <span>↗</span></button><button className="clear-cart" onClick={() => run(api.clear())}>Xóa tất cả</button></div>}
      </aside>

      {checkoutOpen && <div className="modal-backdrop" onClick={() => setCheckoutOpen(false)}><section className="checkout-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-top"><div><span className="eyebrow">BƯỚC CUỐI CÙNG</span><h2>Chuyến đi sắp bắt đầu.</h2></div><button className="icon-button" onClick={() => setCheckoutOpen(false)} aria-label="Đóng">×</button></div>
        <p className="checkout-summary">{cart.count} khách · Tổng cộng <strong>{vnd(cart.total)}</strong></p>
        <form className="checkout-form" onSubmit={placeOrder}>
          <label>Họ và tên<input name="name" autoComplete="name" required maxLength={120} placeholder="Tên người liên hệ" /></label>
          <label>Email<input name="email" type="email" autoComplete="email" required placeholder="ban@email.com" /></label>
          <label>Số điện thoại<input name="phone" type="tel" autoComplete="tel" required maxLength={30} placeholder="090 123 4567" /></label>
          <label>Ngày khởi hành<input name="departureDate" type="date" min={new Date().toISOString().slice(0, 10)} defaultValue={dateInAWeek()} required /></label>
          <fieldset className="payment-options">
            <legend>Thanh toán</legend>
            <label><input type="radio" name="paymentMethod" value="demo" defaultChecked /> Thanh toán demo ngay <span>Giao dịch mô phỏng, không thu tiền thật</span></label>
            <label><input type="radio" name="paymentMethod" value="later" /> Thanh toán sau <span>Giữ lịch, chưa thanh toán</span></label>
          </fieldset>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="button-dark full-button" type="submit">Xác nhận đặt lịch <span>↗</span></button>
          <small>Thanh toán demo chỉ dùng để trải nghiệm, không cần nhập thông tin thẻ.</small>
        </form>
      </section></div>}

      {booking && <div className="modal-backdrop" onClick={() => setBooking(null)}><section className="success-modal" onClick={(event) => event.stopPropagation()}>
        <button className="icon-button modal-close" onClick={() => setBooking(null)} aria-label="Đóng">×</button><span className="success-symbol">✓</span><div className="eyebrow">ĐÃ NHẬN YÊU CẦU ĐẶT LỊCH</div><h2>Hẹn bạn trên<br /><em>những nẻo đường.</em></h2><p>Mã đặt chỗ của bạn</p><strong className="booking-code">{booking.orderNumber}</strong><p className="success-total">Tổng cộng · {vnd(booking.total)}</p><p className={`receipt-payment ${booking.paymentStatus}`}>{booking.paymentStatus === 'paid' ? 'Đã thanh toán demo · Không thu tiền thật' : 'Chưa thanh toán · Bạn có thể thanh toán sau'}</p><button className="button-dark full-button" onClick={() => setBooking(null)}>Tuyệt vời <span>↗</span></button></section></div>}

      {adminOpen && <AdminPanel onClose={() => setAdminOpen(false)} onChanged={() => {
        api.tours({ q: submittedSearch, category, sort, maxPrice }).then(setTours).catch((reason: Error) => setError(reason.message))
        api.categories().then(setCategories).catch((reason: Error) => setError(reason.message))
      }} />}

      <AiChatWidget
        allTours={tours}
        onAddToCart={(tourId) => run(api.add(tourId), 'Đã thêm vào chuyến đi của bạn')}
      />
    </>
  )
}

function TourCard({ tour, index, onAdd }: { tour: Tour; index: number; onAdd: () => void }) {
  return <article className={`tour-card ${index === 0 ? 'tour-card-featured' : ''}`}>
    <div className="tour-image-wrap"><img className="tour-image" src={tour.image} alt={tour.image_alt} loading="lazy" />
      <span className="tour-category">{tour.category}</span><button className="save-button" aria-label={`Lưu ${tour.title}`} onClick={(event) => { event.currentTarget.classList.toggle('is-saved'); event.currentTarget.textContent = event.currentTarget.classList.contains('is-saved') ? '♥' : '♡' }}>♡</button>
      {tour.featured === 1 && <span className="image-caption">ĐIĐÂU CHỌN</span>}
    </div>
    <div className="tour-details"><div className="tour-meta"><span>⌖ {tour.location}</span><span>★ {tour.rating.toFixed(2)} <i>({tour.review_count})</i></span></div>
      <h3>{tour.title}</h3><p>{tour.summary}</p><div className="tour-highlights">{tour.highlights.split(' · ').slice(0, 2).join('　·　')}</div>
      <div className="tour-card-bottom"><div><strong>{vnd(tour.price)}</strong><small> / khách · {tour.duration}</small></div><button className="add-trip" onClick={onAdd} aria-label={`Thêm ${tour.title} vào chuyến đi`}>+</button></div>
    </div>
  </article>
}
