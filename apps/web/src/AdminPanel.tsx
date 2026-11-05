import { FormEvent, useState } from 'react'
import { api, vnd, type Order, type Tour } from './api'

type TourDraft = Omit<Tour, 'id'>
const blankTour: TourDraft = {
  slug: '', title: '', location: '', category: '', duration: '', price: 1000000,
  rating: 5, review_count: 0, summary: '', image: '', image_alt: '',
  highlights: '', included: '', featured: 0, active: 1,
}

export default function AdminPanel({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [token, setToken] = useState('')
  const [authenticated, setAuthenticated] = useState(false)
  const [tours, setTours] = useState<Tour[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [tab, setTab] = useState<'overview' | 'orders' | 'tours'>('overview')
  const [draft, setDraft] = useState<TourDraft>(blankTour)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = async (adminToken: string) => {
    setBusy(true)
    setError('')
    try {
      const [tourData, orderData] = await Promise.all([api.adminTours(adminToken), api.adminOrders(adminToken)])
      setTours(tourData)
      setOrders(orderData)
      setAuthenticated(true)
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (editingId === null) await api.createTour(token, draft)
      else await api.updateTour(token, editingId, draft)
      setDraft(blankTour)
      setEditingId(null)
      await load(token)
      onChanged()
    } catch (reason) {
      setError((reason as Error).message)
      setBusy(false)
    }
  }

  const changeStatus = async (order: Order, status: Order['status']) => {
    try {
      await api.updateOrder(token, order.id, status)
      setOrders((current) => current.map((item) => item.id === order.id ? { ...item, status } : item))
    } catch (reason) {
      setError((reason as Error).message)
    }
  }

  const edit = (tour: Tour) => {
    const { id, ...values } = tour
    setEditingId(id)
    setDraft(values)
    setTab('tours')
    document.querySelector('.admin-body')?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const archive = async (tour: Tour) => {
    if (!window.confirm(`Ẩn trải nghiệm “${tour.title}” khỏi website?`)) return
    try {
      await api.archiveTour(token, tour.id)
      setTours((current) => current.filter((item) => item.id !== tour.id))
      onChanged()
    } catch (reason) {
      setError((reason as Error).message)
    }
  }

  const pendingOrders = orders.filter((order) => order.status === 'pending')
  const confirmedOrders = orders.filter((order) => order.status === 'confirmed')
  const confirmedRevenue = confirmedOrders.reduce((total, order) => total + order.total, 0)
  const recentOrders = [...orders].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 5)
  const currentDate = new Intl.DateTimeFormat('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date())

  return <div className="admin-overlay" onClick={onClose}>
    <section className="admin-panel" onClick={(event) => event.stopPropagation()}>
      {!authenticated ? <>
        <button className="admin-login-close icon-button" onClick={onClose} aria-label="Đóng">×</button>
        <div className="admin-login-layout">
          <aside className="admin-login-art" aria-label="Phong cảnh núi rừng Việt Nam">
            <a className="brand admin-login-brand" href="#" aria-label="Đi Đâu"><span className="brand-mark">Đ</span><span>điđâu<span className="brand-dot">.</span></span></a>
            <div className="admin-login-art-copy"><span>ĐI ĐÂU · WORKSPACE</span><strong>Mỗi hành trình<br />bắt đầu từ đây.</strong></div>
          </aside>
          <form className="admin-login" onSubmit={(event) => { event.preventDefault(); void load(token) }}>
            <span className="admin-lock">✳</span>
            <span className="admin-login-eyebrow">CHÀO MỪNG TRỞ LẠI</span>
            <h3>Đăng nhập quản trị</h3>
            <p>Nhập thông tin để quản lý hành trình và các đơn đặt chỗ.</p>
            <label>Tên đăng nhập<input value="Duong" autoComplete="username" readOnly /></label>
            <label>Mã bảo mật<input type="password" autoComplete="current-password" value={token} onChange={(event) => setToken(event.target.value)} required /></label>
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="button-dark full-button" disabled={busy}>{busy ? 'Đang xác thực…' : 'Đăng nhập an toàn'} <span>↗</span></button>
            <div className="admin-login-info"><span>THÔNG TIN TÀI KHOẢN</span><strong>Tên đăng nhập: Duong</strong><small>Mã bảo mật được xác thực an toàn qua Worker.</small></div>
          </form>
        </div>
      </> : <div className="admin-workspace">
        <aside className="admin-sidebar">
          <a className="brand admin-sidebar-brand" href="#" aria-label="Đi Đâu Travel Admin"><span className="brand-mark">Đ</span><span>điđâu<small>TRAVEL ADMIN</small></span></a>
          <div className="admin-menu-heading"><span className="admin-menu-label">KHÔNG GIAN QUẢN TRỊ</span><span className="admin-sidebar-version">WORKSPACE</span></div>
          <nav className="admin-side-nav" aria-label="Menu quản trị">
            <span className="admin-nav-group-label">TỔNG QUAN</span>
            <button className={tab === 'overview' ? 'active' : ''} aria-current={tab === 'overview' ? 'page' : undefined} onClick={() => setTab('overview')}>
              <span className="admin-nav-icon">⌂</span><span className="admin-nav-copy"><strong>Tổng quan</strong><small>Số liệu hoạt động</small></span><span className="admin-nav-arrow">↗</span>
            </button>
            <span className="admin-nav-group-label">ĐIỀU HÀNH</span>
            <button className={tab === 'orders' ? 'active' : ''} aria-current={tab === 'orders' ? 'page' : undefined} onClick={() => setTab('orders')}>
              <span className="admin-nav-icon">▤</span><span className="admin-nav-copy"><strong>Đơn đặt chỗ</strong><small>Theo dõi và xác nhận</small></span>{pendingOrders.length > 0 && <b className="admin-nav-count">{pendingOrders.length}</b>}
            </button>
            <span className="admin-nav-group-label">NỘI DUNG</span>
            <button className={tab === 'tours' ? 'active' : ''} aria-current={tab === 'tours' ? 'page' : undefined} onClick={() => setTab('tours')}>
              <span className="admin-nav-icon">✳</span><span className="admin-nav-copy"><strong>Trải nghiệm</strong><small>Quản lý tour và điểm đến</small></span><b className="admin-nav-count">{tours.length}</b>
            </button>
          </nav>
          <div className="admin-sidebar-account"><span className="admin-account-avatar">D</span><div><strong>Duong</strong><small>Quản trị viên · Đi Đâu</small></div><button onClick={() => { setAuthenticated(false); setToken('') }} aria-label="Đăng xuất">↪</button></div>
        </aside>
        <div className="admin-workspace-main">
          <header className="admin-topbar"><div className="admin-mobile-brand"><span className="brand-mark">Đ</span> điđâu <small>TRAVEL ADMIN</small></div><div className="admin-topbar-actions"><span className="admin-online"><i /> Quản trị viên</span><button onClick={() => { setAuthenticated(false); setToken('') }}>Đăng xuất</button><button className="icon-button" onClick={onClose} aria-label="Đóng">×</button></div></header>
          {error && <div className="inline-error admin-error" role="alert">{error}<button onClick={() => setError('')} aria-label="Đóng thông báo">×</button></div>}
          <div className="admin-body">
          {tab === 'overview' ? <section className="admin-overview">
            <div className="admin-page-heading"><div><span className="eyebrow">ĐIĐÂU · WORKSPACE</span><h2>Tổng quan</h2><p>Chào bạn, đây là tình hình hoạt động hôm nay.</p></div><time>{currentDate}</time></div>
            <div className="admin-stat-grid">
              <article className="admin-stat-card"><span className="admin-stat-icon">▤</span><div><small>Tổng đơn đặt chỗ</small><strong>{orders.length}</strong><span>Tất cả yêu cầu đặt chuyến</span></div></article>
              <article className="admin-stat-card pending"><span className="admin-stat-icon">◷</span><div><small>Chờ xác nhận</small><strong>{pendingOrders.length}</strong><span>Cần bạn phản hồi</span></div></article>
              <article className="admin-stat-card confirmed"><span className="admin-stat-icon">✓</span><div><small>Đã xác nhận</small><strong>{confirmedOrders.length}</strong><span>Chuyến đi đã lên lịch</span></div></article>
              <article className="admin-stat-card revenue"><span className="admin-stat-icon">↗</span><div><small>Doanh thu xác nhận</small><strong>{vnd(confirmedRevenue)}</strong><span>Từ các đơn đã xác nhận</span></div></article>
            </div>
            <section className="admin-recent-orders">
              <div className="admin-section-heading"><div><span className="eyebrow">MỚI NHẤT</span><h3>Đơn đặt chỗ gần đây</h3></div><button onClick={() => setTab('orders')}>Xem tất cả ↗</button></div>
              {recentOrders.length === 0 ? <div className="admin-empty">Chưa có yêu cầu đặt chỗ nào.</div> : <div className="admin-recent-list">
                {recentOrders.map((order) => <article className="admin-recent-row" key={order.id}>
                  <span className="admin-recent-avatar">✳</span>
                  <div className="admin-recent-customer"><strong>{order.customer_name}</strong><small>{order.order_number} · {order.items || 'Chuyến đi'}</small></div>
                  <time>{new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(order.created_at))}</time>
                  <span className={`status status-${order.status}`}>{order.status === 'pending' ? 'Chờ xác nhận' : order.status === 'confirmed' ? 'Đã xác nhận' : 'Đã hủy'}</span>
                  <strong className="admin-recent-total">{vnd(order.total)}</strong>
                </article>)}
              </div>}
            </section>
          </section> : tab === 'orders' ? <div className="admin-orders">
            {orders.length === 0 && <div className="admin-empty">Chưa có yêu cầu đặt chỗ nào.</div>}
            {orders.map((order) => <article className="admin-order" key={order.id}>
              <div className="order-top"><strong>{order.order_number}</strong><span className={`status status-${order.status}`}>{order.status === 'pending' ? 'Chờ xác nhận' : order.status === 'confirmed' ? 'Đã xác nhận' : 'Đã hủy'}</span></div>
              <h3>{order.customer_name}</h3><p>{order.email} · {order.phone}</p><p>{order.items || 'Chuyến đi'} · Khởi hành {order.departure_date}</p>
              <div className="order-payment">
                <span className="order-payment-label">Thanh toán</span>
                <span className={`payment-status payment-${order.payment_status}`}>
                  <i aria-hidden="true" />
                  {order.payment_status === 'paid' ? 'Đã thanh toán · Demo' : 'Chưa thanh toán'}
                </span>
              </div>
              <div className="order-bottom"><strong>{vnd(order.total)}</strong><div><button disabled={order.status === 'confirmed'} onClick={() => void changeStatus(order, 'confirmed')}>Xác nhận</button><button disabled={order.status === 'cancelled'} onClick={() => void changeStatus(order, 'cancelled')}>Hủy đơn</button></div></div>
            </article>)}
          </div> : <div className="admin-tour-management">
            <form className="tour-editor" onSubmit={save}>
              <div className="editor-heading"><div><span className="eyebrow">{editingId === null ? 'THÊM VÀO BẢN ĐỒ' : 'CHỈNH SỬA HÀNH TRÌNH'}</span><h3>{editingId === null ? 'Tạo trải nghiệm mới' : 'Cập nhật trải nghiệm'}</h3></div>{editingId !== null && <button className="clear-cart" type="button" onClick={() => { setDraft(blankTour); setEditingId(null) }}>Hủy sửa</button>}</div>
              <div className="editor-grid">
                <label>Tên trải nghiệm<input required value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
                <label>Slug duy nhất<input required value={draft.slug} onChange={(event) => setDraft({ ...draft, slug: event.target.value })} /></label>
                <label>Điểm đến<input required value={draft.location} onChange={(event) => setDraft({ ...draft, location: event.target.value })} /></label>
                <label>Phong cách<input required value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} /></label>
                <label>Thời lượng<input required value={draft.duration} onChange={(event) => setDraft({ ...draft, duration: event.target.value })} /></label>
                <label>Giá / khách (VND)<input type="number" min="1" step="1000" required value={draft.price} onChange={(event) => setDraft({ ...draft, price: Number(event.target.value) })} /></label>
                <label>Đánh giá<input type="number" min="0" max="5" step="0.01" value={draft.rating} onChange={(event) => setDraft({ ...draft, rating: Number(event.target.value) })} /></label>
                <label>Số lượt đánh giá<input type="number" min="0" value={draft.review_count} onChange={(event) => setDraft({ ...draft, review_count: Number(event.target.value) })} /></label>
                <label className="span-two">Mô tả ngắn<textarea required rows={2} value={draft.summary} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} /></label>
                <label className="span-two">URL ảnh<input type="url" required value={draft.image} onChange={(event) => setDraft({ ...draft, image: event.target.value })} /></label>
                <label className="span-two">Mô tả ảnh<input required value={draft.image_alt} onChange={(event) => setDraft({ ...draft, image_alt: event.target.value })} /></label>
                <label className="span-two">Điểm nhấn (ngăn cách bằng ·)<input required value={draft.highlights} onChange={(event) => setDraft({ ...draft, highlights: event.target.value })} /></label>
                <label className="span-two">Bao gồm<input required value={draft.included} onChange={(event) => setDraft({ ...draft, included: event.target.value })} /></label>
                <label className="check-label"><input type="checkbox" checked={draft.featured === 1} onChange={(event) => setDraft({ ...draft, featured: event.target.checked ? 1 : 0 })} /> Nổi bật</label>
                <label className="check-label"><input type="checkbox" checked={draft.active === 1} onChange={(event) => setDraft({ ...draft, active: event.target.checked ? 1 : 0 })} /> Đang hiển thị</label>
              </div>
              <button className="button-dark full-button" disabled={busy}>{editingId === null ? 'Thêm trải nghiệm' : 'Lưu thay đổi'} <span>↗</span></button>
            </form>
            <div className="tour-admin-list"><h3>Danh sách trải nghiệm</h3>{tours.map((tour) => <div className="tour-admin-row" key={tour.id}><img src={tour.image} alt="" /><div><strong>{tour.title}</strong><span>{tour.location} · {vnd(tour.price)} {tour.active ? '' : '· Đã ẩn'}</span></div><button onClick={() => edit(tour)}>Sửa</button><button onClick={() => void archive(tour)}>Ẩn</button></div>)}</div>
          </div>}
          </div>
        </div>
      </div>}
    </section>
  </div>
}
