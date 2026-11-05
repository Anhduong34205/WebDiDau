import { Hono } from 'hono'
import type { Context, MiddlewareHandler } from 'hono'

type Env = { Bindings: { DB: D1Database; CART: KVNamespace; AI?: any; ADMIN_TOKEN?: string } }
type Line = { tourId: number; qty: number }
type Tour = {
  id: number
  slug: string
  title: string
  location: string
  category: string
  duration: string
  price: number
  rating: number
  review_count: number
  summary: string
  image: string
  image_alt: string
  highlights: string
  included: string
  featured: number
  active: number
}
type BookingLine = { tour: Tour; qty: number }
type Cart = { items: BookingLine[]; total: number; count: number }
type TourInput = Omit<Tour, 'id' | 'review_count'> & { review_count?: number }

const app = new Hono<Env>().basePath('/api')
const CART_TTL = 60 * 60 * 24 * 30
const CACHE_TTL = 60 * 5

const cartKey = (c: Context<Env>) => {
  const id = c.req.header('x-cart-id')
  return id && /^[\w-]{8,64}$/.test(id) ? `cart:${id}` : null
}

const readLines = async (c: Context<Env>, key: string) =>
  (await c.env.CART.get<Line[]>(key, 'json')) ?? []

const writeLines = (c: Context<Env>, key: string, lines: Line[]) =>
  c.env.CART.put(key, JSON.stringify(lines), { expirationTtl: CART_TTL })

const hydrate = async (c: Context<Env>, lines: Line[]): Promise<Cart> => {
  if (!lines.length) return { items: [], total: 0, count: 0 }
  const ids = lines.map((line) => line.tourId)
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM tours WHERE active = 1 AND id IN (${ids.map(() => '?').join(',')})`,
  ).bind(...ids).all<Tour>()
  const byId = new Map(results.map((tour) => [tour.id, tour]))
  const items = lines.flatMap((line) => {
    const tour = byId.get(line.tourId)
    return tour ? [{ tour, qty: line.qty }] : []
  })
  return {
    items,
    total: items.reduce((sum, item) => sum + item.tour.price * item.qty, 0),
    count: items.reduce((sum, item) => sum + item.qty, 0),
  }
}

const requireAdmin: MiddlewareHandler<Env> = async (c, next) => {
  if (!c.env.ADMIN_TOKEN) return c.json({ error: 'Quản trị chưa được cấu hình ADMIN_TOKEN.' }, 503)
  const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
  if (!token || token !== c.env.ADMIN_TOKEN) return c.json({ error: 'Mã quản trị không hợp lệ.' }, 401)
  await next()
}

const readJson = async <T>(c: Context<Env>) => {
  try {
    return await c.req.json<T>()
  } catch {
    return null
  }
}

const isTourInput = (value: unknown): value is TourInput => {
  if (!value || typeof value !== 'object') return false
  const input = value as Record<string, unknown>
  return ['slug', 'title', 'location', 'category', 'duration', 'summary', 'image', 'image_alt', 'highlights', 'included']
    .every((key) => typeof input[key] === 'string' && input[key].trim().length > 0) &&
    typeof input.price === 'number' && Number.isSafeInteger(input.price) && input.price > 0 &&
    typeof input.rating === 'number' && input.rating >= 0 && input.rating <= 5 &&
    (input.featured === 0 || input.featured === 1) &&
    (input.active === 0 || input.active === 1)
}

const invalidateTours = async (c: Context<Env>) => {
  const revision = Number(await c.env.CART.get('tours:revision') ?? '0')
  await c.env.CART.put('tours:revision', String(revision + 1))
}

app.get('/tours', async (c) => {
  const query = c.req.query('q')?.trim().slice(0, 100) ?? ''
  const category = c.req.query('category')?.trim().slice(0, 60) ?? ''
  const maxPrice = Number(c.req.query('maxPrice'))
  const sort = c.req.query('sort') ?? 'recommended'
  const revision = await c.env.CART.get('tours:revision') ?? '0'
  const cacheKey = `tours:${revision}:${new URL(c.req.url).searchParams.toString()}`
  const cached = await c.env.CART.get<Tour[]>(cacheKey, 'json')
  if (cached) return c.json(cached)

  const conditions = ['active = 1']
  const bindings: (string | number)[] = []
  if (query) {
    conditions.push('(title LIKE ? OR location LIKE ? OR summary LIKE ?)')
    const pattern = `%${query}%`
    bindings.push(pattern, pattern, pattern)
  }
  if (category) {
    conditions.push('category = ?')
    bindings.push(category)
  }
  if (Number.isFinite(maxPrice) && maxPrice > 0) {
    conditions.push('price <= ?')
    bindings.push(maxPrice)
  }
  const orderBy = sort === 'price-low' ? 'price ASC' : sort === 'price-high'
    ? 'price DESC' : sort === 'rating' ? 'rating DESC, review_count DESC' : 'featured DESC, rating DESC'
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM tours WHERE ${conditions.join(' AND ')} ORDER BY ${orderBy}`,
  ).bind(...bindings).all<Tour>()
  await c.env.CART.put(cacheKey, JSON.stringify(results), { expirationTtl: CACHE_TTL })
  return c.json(results)
})

app.get('/categories', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT DISTINCT category FROM tours WHERE active = 1 ORDER BY category',
  ).all<{ category: string }>()
  return c.json(results.map(({ category }) => category))
})

app.get('/cart', async (c) => {
  const key = cartKey(c)
  if (!key) return c.json({ error: 'Thiếu mã giỏ hàng.' }, 400)
  return c.json(await hydrate(c, await readLines(c, key)))
})

app.post('/cart/items', async (c) => {
  const key = cartKey(c)
  if (!key) return c.json({ error: 'Thiếu mã giỏ hàng.' }, 400)
  const body = await readJson<{ tourId?: number }>(c)
  if (!body || !Number.isSafeInteger(body.tourId)) return c.json({ error: 'Trải nghiệm không hợp lệ.' }, 400)
  const exists = await c.env.DB.prepare('SELECT 1 FROM tours WHERE id = ? AND active = 1')
    .bind(body.tourId).first()
  if (!exists) return c.json({ error: 'Không tìm thấy trải nghiệm.' }, 404)

  const lines = await readLines(c, key)
  const line = lines.find((item) => item.tourId === body.tourId)
  if (line) line.qty = Math.min(line.qty + 1, 10)
  else lines.push({ tourId: body.tourId!, qty: 1 })
  await writeLines(c, key, lines)
  return c.json(await hydrate(c, lines))
})

app.put('/cart/items/:id', async (c) => {
  const key = cartKey(c)
  if (!key) return c.json({ error: 'Thiếu mã giỏ hàng.' }, 400)
  const tourId = Number(c.req.param('id'))
  const body = await readJson<{ qty?: number }>(c)
  if (!Number.isSafeInteger(tourId) || !body || !Number.isSafeInteger(body.qty) ||
    (body.qty! < 0 || body.qty! > 10)) {
    return c.json({ error: 'Số lượng không hợp lệ (tối đa 10 khách mỗi trải nghiệm).' }, 400)
  }
  const lines = await readLines(c, key)
  const updated = body.qty! > 0
    ? lines.map((line) => line.tourId === tourId ? { ...line, qty: body.qty! } : line)
    : lines.filter((line) => line.tourId !== tourId)
  await writeLines(c, key, updated)
  return c.json(await hydrate(c, updated))
})

app.delete('/cart', async (c) => {
  const key = cartKey(c)
  if (!key) return c.json({ error: 'Thiếu mã giỏ hàng.' }, 400)
  await c.env.CART.delete(key)
  return c.json({ items: [], total: 0, count: 0 })
})

app.post('/orders', async (c) => {
  const key = cartKey(c)
  if (!key) return c.json({ error: 'Thiếu mã giỏ hàng.' }, 400)
  const body = await readJson<{
    name?: string
    email?: string
    phone?: string
    departureDate?: string
    paymentDemo?: boolean
  }>(c)
  if (!body || !body.name?.trim() || body.name.trim().length > 120 ||
    !body.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email) ||
    !body.phone?.trim() || body.phone.trim().length > 30 ||
    !body.departureDate || !/^\d{4}-\d{2}-\d{2}$/.test(body.departureDate) ||
    (body.paymentDemo !== undefined && typeof body.paymentDemo !== 'boolean')) {
    return c.json({ error: 'Vui lòng kiểm tra thông tin liên hệ, ngày khởi hành và lựa chọn thanh toán.' }, 400)
  }
  const departure = new Date(`${body.departureDate}T00:00:00.000Z`)
  if (!Number.isFinite(departure.getTime()) || departure.toISOString().slice(0, 10) !== body.departureDate) {
    return c.json({ error: 'Ngày khởi hành không hợp lệ.' }, 400)
  }
  if (body.departureDate < new Date().toISOString().slice(0, 10)) {
    return c.json({ error: 'Ngày khởi hành không thể ở trong quá khứ.' }, 400)
  }
  const lines = await readLines(c, key)
  const cart = await hydrate(c, lines)
  if (!cart.count) return c.json({ error: 'Giỏ trải nghiệm đang trống.' }, 400)

  const orderId = crypto.randomUUID()
  const orderNumber = `VT-${new Date().getFullYear()}-${orderId.replaceAll('-', '').slice(0, 12).toUpperCase()}`
  const paymentStatus = body.paymentDemo ? 'paid' : 'unpaid'
  const paidAt = body.paymentDemo ? new Date().toISOString() : null
  const statements = [
    c.env.DB.prepare(
      'INSERT INTO orders (id, order_number, customer_name, email, phone, departure_date, total, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(orderId, orderNumber, body.name.trim(), body.email.trim().toLowerCase(), body.phone.trim(),
      body.departureDate, cart.total, 'pending', new Date().toISOString()),
    ...cart.items.map(({ tour, qty }) => c.env.DB.prepare(
      'INSERT INTO order_items (order_id, tour_id, tour_title, unit_price, quantity) VALUES (?, ?, ?, ?, ?)',
    ).bind(orderId, tour.id, tour.title, tour.price, qty)),
    c.env.DB.prepare(
      'INSERT INTO order_payments (order_id, payment_status, payment_method, paid_at) VALUES (?, ?, ?, ?)',
    ).bind(orderId, paymentStatus, body.paymentDemo ? 'demo' : null, paidAt),
  ]
  await c.env.DB.batch(statements)
  await c.env.CART.delete(key)
  return c.json({ id: orderId, orderNumber, total: cart.total, status: 'pending', paymentStatus }, 201)
})

app.post('/orders/lookup', async (c) => {
  const body = await readJson<{ lookupType?: string; value?: string }>(c)
  const lookupType = body?.lookupType
  const value = body?.value?.trim() ?? ''
  if (!value || value.length > 254 ||
    !['orderNumber', 'email', 'phone'].includes(lookupType ?? '')) {
    return c.json({ error: 'Chọn mã đơn, email hoặc số điện thoại và nhập thông tin tra cứu.' }, 400)
  }

  let where: string
  let binding: string
  if (lookupType === 'orderNumber') {
    binding = value.toUpperCase()
    if (!/^[A-Z0-9-]{8,40}$/.test(binding)) {
      return c.json({ error: 'Mã đơn đặt chỗ chưa hợp lệ.' }, 400)
    }
    where = 'o.order_number = ?'
  } else if (lookupType === 'email') {
    binding = value.toLowerCase()
    if (binding.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(binding)) {
      return c.json({ error: 'Email chưa hợp lệ.' }, 400)
    }
    where = 'lower(o.email) = ?'
  } else {
    binding = value.replace(/\D/g, '')
    if (binding.length < 8 || binding.length > 15) {
      return c.json({ error: 'Số điện thoại chưa hợp lệ.' }, 400)
    }
    where = `replace(replace(replace(replace(replace(replace(o.phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', '') = ?`
  }

  const clientIp = c.req.header('cf-connecting-ip')
  if (clientIp) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(clientIp))
    const ipHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
    const bucket = Math.floor(Date.now() / (15 * 60 * 1000))
    const rateLimitKey = `order-lookup:${ipHash}:${bucket}`
    const attempts = Number(await c.env.CART.get(rateLimitKey) ?? '0')
    if (attempts >= 20) {
      return c.json({ error: 'Bạn đã tra cứu nhiều lần. Vui lòng thử lại sau ít phút.' }, 429)
    }
    await c.env.CART.put(rateLimitKey, String(attempts + 1), { expirationTtl: 15 * 60 })
  }

  const { results } = await c.env.DB.prepare(
    `SELECT o.order_number, o.departure_date, o.total, o.status,
            COALESCE(p.payment_status, 'unpaid') AS payment_status,
            COALESCE(GROUP_CONCAT(oi.tour_title || ' × ' || oi.quantity, ', '), '') AS items
     FROM orders o
     LEFT JOIN order_items oi ON oi.order_id = o.id
     LEFT JOIN order_payments p ON p.order_id = o.id
     WHERE ${where}
     GROUP BY o.id
     ORDER BY o.created_at DESC`,
  ).bind(binding).all<{
    order_number: string
    departure_date: string
    total: number
    status: 'pending' | 'confirmed' | 'cancelled'
    payment_status: 'unpaid' | 'paid'
    items: string
  }>()
  if (!results.length) {
    return c.json({ error: 'Không tìm thấy đơn đặt chỗ với thông tin đã nhập.' }, 404)
  }
  return c.json(results)
})

app.post('/newsletter', async (c) => {
  const body = await readJson<{ email?: string }>(c)
  const email = body?.email?.trim().toLowerCase()
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: 'Địa chỉ email chưa hợp lệ.' }, 400)
  }
  try {
    await c.env.DB.prepare('INSERT INTO newsletter_subscribers (email, subscribed_at) VALUES (?, ?)')
      .bind(email, new Date().toISOString()).run()
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE')) {
      return c.json({ error: 'Email này đã đăng ký nhận thư rồi.' }, 409)
    }
    throw error
  }
  return c.json({ ok: true }, 201)
})

const parseBudgetFromQuery = (query: string): number | null => {
  const match = query.match(/(?:dưới|tầm|khoảng|ngân sách|tối đa|dưới mức|chừng)\s*([\d,.]+)\s*(triệu|tr|k|nghìn|đ|vnd)?/i)
  if (match) {
    const num = parseFloat(match[1].replace(',', '.'))
    if (!Number.isFinite(num)) return null
    const unit = match[2]?.toLowerCase()
    if (unit === 'triệu' || unit === 'tr') return num * 1_000_000
    if (unit === 'k' || unit === 'nghìn') return num * 1_000
    if (num < 50) return num * 1_000_000
    return num
  }
  return null
}

const formatVND = (price: number) =>
  new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(price)

const generateSmartFallbackReply = (query: string, tours: Tour[]): string => {
  const q = query.toLowerCase()
  const budget = parseBudgetFromQuery(q)

  // 1. Kiem tra cau hoi ngoai pham vi tour/du lich
  const nonTravelTopics = [
    'lập trình', 'code', 'python', 'javascript', 'html', 'css', 'toán', 'vật lý', 'hóa học',
    'chính trị', 'tin tức', 'thời sự', 'chứng khoán', 'crypto', 'bitcoin', 'thời tiết hôm nay',
    'dịch thuật', 'bóng đá', 'nấu ăn'
  ]
  if (nonTravelTopics.some((topic) => q.includes(topic))) {
    return 'Dạ Đi Đâu AI chỉ hỗ trợ tư vấn các tour và trải nghiệm du lịch hiện có trên website Đi Đâu. Rất mong bạn thông cảm! Bạn có thể hỏi mình về các tour du lịch nhé.'
  }

  const isAskingPrice = /(?:giá|bao nhiêu tiền|hết bao nhiêu|chi phí|mấy tiền|giá vé|vé bao nhiêu)/i.test(q)
  const isAskingDetails = /(?:chi tiết|mô tả|có gì|có những gì|tham quan|danh lam|thắng cảnh|địa điểm nào|sự kiện|chơi gì|trải nghiệm)/i.test(q)

  // Phat hien thoi luong neu khach yeu cau
  let targetDuration = ''
  if (/3\s*ngày\s*2\s*đêm|3n2đ|3n2d/i.test(q)) targetDuration = '3 ngày 2 đêm'
  else if (/2\s*ngày\s*1\s*đêm|2n1đ|2n1d/i.test(q)) targetDuration = '2 ngày 1 đêm'
  else if (/1\s*ngày|trong ngày|ngay trong ngay/i.test(q)) targetDuration = '1 ngày'
  else if (/5\s*ngày\s*4\s*đêm|5n4đ|5n4d/i.test(q)) targetDuration = '5 ngày 4 đêm'

  const activeTours = tours.filter((t) => t.active === 1)

  // 2. Kiem tra xem nguoi dung co hoi ve mot dia diem CO TREN WEB khong
  const matchedTour = activeTours.find((t) => {
    const loc = t.location.toLowerCase()
    const title = t.title.toLowerCase()
    return q.includes(loc) || q.includes(title) ||
      (loc.includes('quảng ninh') && (q.includes('hạ long') || q.includes('bình liêu'))) ||
      (loc.includes('lào cai') && (q.includes('sa pa') || q.includes('sapa') || q.includes('fansipan'))) ||
      (loc.includes('quảng nam') && (q.includes('hội an') || q.includes('mỹ sơn'))) ||
      (loc.includes('bà rịa') && (q.includes('vũng tàu') || q.includes('côn đảo'))) ||
      (loc.includes('kiên giang') && (q.includes('phú quốc') || q.includes('nam du'))) ||
      (loc.includes('sơn la') && (q.includes('mộc châu') || q.includes('tà xùa'))) ||
      (loc.includes('quảng bình') && (q.includes('phong nha') || q.includes('hang én'))) ||
      (loc.includes('kon tum') && (q.includes('măng đen'))) ||
      (loc.includes('bình thuận') && (q.includes('mũi né') || q.includes('phan thiết'))) ||
      (loc.includes('hải phòng') && (q.includes('lan hạ') || q.includes('cát bà'))) ||
      (loc.includes('đà nẵng') && q.includes('đà nẵng')) ||
      (loc.includes('an giang') && (q.includes('trà sư') || q.includes('châu đốc'))) ||
      (loc.includes('cà mau') && q.includes('cà mau')) ||
      (loc.includes('đồng tháp') && (q.includes('đồng tháp') || q.includes('tràm chim') || q.includes('tháp mười'))) ||
      (loc.includes('bến tre') && q.includes('bến tre')) ||
      (loc.includes('tây ninh') && (q.includes('bà đen') || q.includes('tây ninh'))) ||
      (loc.includes('gia lai') && (q.includes('gia lai') || q.includes('pleiku') || q.includes('biển hồ'))) ||
      (loc.includes('đắk lắk') && (q.includes('đắk lắk') || q.includes('buôn ma thuột') || q.includes('hồ lắk')))
  })

  if (matchedTour) {
    if (isAskingPrice && !isAskingDetails) {
      return `Dạ tour **${matchedTour.title}** [TOUR:${matchedTour.id}] hiện có giá niêm yết chính xác là **${formatVND(matchedTour.price)}/khách** với thời lượng **${matchedTour.duration}**.\n\n• **Điểm tham quan nổi bật:** ${matchedTour.highlights}\n• **Dịch vụ đã bao gồm:** ${matchedTour.included}\n\nBạn có thể nhấn vào thẻ tour bên dưới để đặt chỗ trực tiếp nhé!`
    }
    return `Dạ Đi Đâu hiện có tour **${matchedTour.title}** [TOUR:${matchedTour.id}] khám phá ${matchedTour.location} (${matchedTour.duration} · **${formatVND(matchedTour.price)}**):\n\n• **Mô tả hành trình:** ${matchedTour.summary}\n• **Các địa điểm tham quan & trải nghiệm:** ${matchedTour.highlights}\n• **Dịch vụ bao gồm:** ${matchedTour.included}\n\nBạn có thể nhấn vào thẻ tour bên dưới để xem thêm thông tin chi tiết hoặc đặt giữ chỗ trước nhé!`
  }

  // 3. Kiem tra cac dia diem KHONG CO TREN WEB -> Bao chua co + goi y dia diem tuong tu / gan do
  type NeighborMapping = {
    keywords: string[]
    name: string
    suggestedQuery: (t: Tour) => boolean
    suggestedLocNames: string
  }

  const neighborMappings: NeighborMapping[] = [
    {
      keywords: ['thái nguyên', 'thai nguyen', 'tuyên quang', 'tuyen quang', 'lạng sơn', 'lang son', 'bắc giang', 'bac giang', 'phú thọ', 'phu tho', 'vĩnh phúc', 'vinh phuc', 'hải dương', 'hai duong', 'hưng yên', 'hung yen', 'thái bình', 'thai binh', 'nam định', 'nam dinh', 'hà nam', 'ha nam'],
      name: 'Thái Nguyên / lân cận miền Bắc',
      suggestedQuery: (t) => ['Bắc Kạn', 'Cao Bằng', 'Hà Giang', 'Ninh Bình', 'Lào Cai'].includes(t.location),
      suggestedLocNames: 'Bắc Kạn (Hồ Ba Bể), Hà Giang, Cao Bằng (Thác Bản Giốc), Ninh Bình hoặc Sa Pa'
    },
    {
      keywords: ['nghệ an', 'nghe an', 'hà tĩnh', 'ha tinh', 'quảng trị', 'quang tri'],
      name: 'Bắc Trung Bộ',
      suggestedQuery: (t) => ['Quảng Bình', 'Huế', 'Đà Nẵng'].some((l) => t.location.includes(l)),
      suggestedLocNames: 'Quảng Bình (Phong Nha, Hang Én), Cố đô Huế hoặc Đà Nẵng'
    },
    {
      keywords: ['đắk nông', 'dak nong', 'đắc nông'],
      name: 'Đắk Nông',
      suggestedQuery: (t) => ['Đắk Lắk', 'Kon Tum', 'Lâm Đồng', 'Gia Lai'].includes(t.location),
      suggestedLocNames: 'Buôn Ma Thuột (Đắk Lắk), Măng Đen (Kon Tum) hoặc Đà Lạt'
    },
    {
      keywords: ['tiền giang', 'tien giang', 'vĩnh long', 'vinh long', 'trà vinh', 'tra vinh', 'hậu giang', 'hau giang', 'sóc trăng', 'soc trang', 'bạc liêu', 'bac lieu', 'long an'],
      name: 'miền Tây lân cận',
      suggestedQuery: (t) => ['Cần Thơ', 'Bến Tre', 'Đồng Tháp', 'An Giang', 'Cà Mau'].includes(t.location),
      suggestedLocNames: 'Bến Tre, Cần Thơ, Đồng Tháp hoặc An Giang'
    },
    {
      keywords: ['thái lan', 'thailand', 'singapore', 'hàn quốc', 'korea', 'nhật bản', 'japan', 'châu âu', 'mỹ', 'bali', 'tokyo', 'seoul', 'bangkok'],
      name: 'nước ngoài',
      suggestedQuery: (t) => ['Kiên Giang', 'Quảng Ninh', 'Khánh Hòa', 'Đà Nẵng'].includes(t.location),
      suggestedLocNames: 'Phú Quốc, Vịnh Hạ Long, Nha Trang hoặc Đà Nẵng'
    }
  ]

  const matchedNeighbor = neighborMappings.find((m) => m.keywords.some((k) => q.includes(k)))
  if (matchedNeighbor) {
    const rawPlace = matchedNeighbor.keywords.find((k) => q.includes(k)) || matchedNeighbor.name
    const placeWord = rawPlace.charAt(0).toUpperCase() + rawPlace.slice(1)
    let suggestions = activeTours.filter(matchedNeighbor.suggestedQuery)
    if (targetDuration) {
      const matchDur = suggestions.filter((t) => t.duration.toLowerCase().includes(targetDuration.toLowerCase()))
      if (matchDur.length > 0) suggestions = matchDur
    }
    if (budget) {
      const matchBud = suggestions.filter((t) => t.price <= budget)
      if (matchBud.length > 0) suggestions = matchBud
    }
    const picks = suggestions.slice(0, 2)
    const pickList = picks.map((t) =>
      `• [TOUR:${t.id}] **${t.title}** (${t.location} · ${t.duration} · **${formatVND(t.price)}**)\n  - *Điểm tham quan:* ${t.highlights}\n  - *Trải nghiệm:* ${t.summary}`
    ).join('\n\n')

    return `Dạ hiện tại chưa có tour du lịch ${placeWord} này, chúng tôi sẽ cập nhật sớm và bổ sung thông tin về địa điểm du lịch này!!\n\nTuy nhiên, Đi Đâu xin gợi ý bạn những địa điểm du lịch nổi tiếng gần chỗ đó (${matchedNeighbor.suggestedLocNames}) có hành trình tương tự đang có sẵn trên website:\n\n${pickList}\n\nBạn có thể tham khảo chi tiết các tour trên thẻ bên dưới nhé!`
  }

  // 4. Neu hoi theo the loai / tieu chi khac
  let candidates = [...activeTours]
  if (targetDuration) {
    const byDur = candidates.filter((t) => t.duration.toLowerCase().includes(targetDuration.toLowerCase()))
    if (byDur.length > 0) candidates = byDur
  }
  if (budget) {
    const withBudget = candidates.filter((t) => t.price <= budget)
    if (withBudget.length > 0) candidates = withBudget
  }
  if (q.includes('biển') || q.includes('đảo') || q.includes('lặn')) {
    const bySea = candidates.filter((t) => t.category === 'Biển đảo' || t.title.toLowerCase().includes('biển'))
    if (bySea.length > 0) candidates = bySea
  } else if (q.includes('săn mây') || q.includes('leo núi') || q.includes('trekking') || q.includes('núi') || q.includes('phiêu lưu')) {
    const byAdv = candidates.filter((t) => t.category === 'Phiêu lưu' || t.summary.toLowerCase().includes('mây'))
    if (byAdv.length > 0) candidates = byAdv
  } else if (q.includes('nghỉ dưỡng') || q.includes('thư giãn') || q.includes('resort') || q.includes('an yên')) {
    const byRetreat = candidates.filter((t) => t.category === 'Nghỉ dưỡng')
    if (byRetreat.length > 0) candidates = byRetreat
  } else if (q.includes('văn hóa') || q.includes('lịch sử') || q.includes('phố cổ') || q.includes('ẩm thực')) {
    const byCulture = candidates.filter((t) => t.category === 'Văn hóa')
    if (byCulture.length > 0) candidates = byCulture
  } else {
    // Co y dinh hoi dia diem du lich nhung khong khop tour nao tren web
    const hasIntent = ['tour', 'đi', 'ở', 'tại', 'du lịch', 'khám phá', 'chuyến đi', 'địa điểm', 'tỉnh'].some((k) => q.includes(k))
    if (hasIntent) {
      const picks = candidates.slice(0, 2)
      const pickList = picks.map((t) =>
        `• [TOUR:${t.id}] **${t.title}** (${t.location} · ${t.duration} · **${formatVND(t.price)}**)\n  - *Điểm tham quan:* ${t.highlights}`
      ).join('\n\n')
      return `Dạ hiện tại chưa có tour du lịch tại địa điểm này, chúng tôi sẽ cập nhật sớm và bổ sung thông tin về địa điểm du lịch này!!\n\nBạn có thể tham khảo một số hành trình hấp dẫn với trải nghiệm đặc sắc đang có sẵn trên website Đi Đâu nhé:\n\n${pickList}`
    }
  }

  const selected = candidates.slice(0, 2)
  if (selected.length === 0) {
    return 'Dạ hiện tại chưa có tour du lịch này, chúng tôi sẽ cập nhật sớm và bổ sung thông tin về địa điểm du lịch này!! Bạn có thể tham khảo các hành trình đặc sắc khác đang có trên website Đi Đâu nhé!'
  }

  const intro = budget || targetDuration
    ? `Dưới đây là hành trình phù hợp nhất với tiêu chí của bạn (${targetDuration ? targetDuration + ' · ' : ''}${budget ? 'ngân sách ' + formatVND(budget) : ''}):`
    : 'Dạ, để bạn cảm nhận trọn vẹn vẻ đẹp bản địa, Đi Đâu gợi ý cho bạn hành trình:'

  const list = selected.map((t) =>
    `• [TOUR:${t.id}] **${t.title}** (${t.location} · ${t.duration} · **${formatVND(t.price)}**)\n  - *Điểm tham quan:* ${t.highlights}\n  - *Trải nghiệm:* ${t.summary}`
  ).join('\n\n')

  return `${intro}\n\n${list}\n\nBạn có thể nhấn vào thẻ tour bên dưới để xem chi tiết hoặc đặt tour nhé!`
}

app.post('/chat', async (c) => {
  const body = await readJson<{ messages?: Array<{ role?: string; content?: string }> }>(c)
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ error: 'Vui lòng nhập câu hỏi hoặc yêu cầu tư vấn.' }, 400)
  }

  const sanitizedMessages = body.messages
    .filter((m): m is { role: 'user' | 'assistant'; content: string } =>
      Boolean(m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    )
    .map((m) => ({ role: m.role, content: m.content.trim().slice(0, 500) }))
    .filter((m) => m.content.length > 0)

  if (sanitizedMessages.length === 0) {
    return c.json({ error: 'Nội dung câu hỏi không hợp lệ.' }, 400)
  }

  const latestUser = [...sanitizedMessages].reverse().find((m) => m.role === 'user')
  const userQuery = latestUser ? latestUser.content : ''

  const clientIp = c.req.header('cf-connecting-ip')
  if (clientIp) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(clientIp))
    const ipHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
    const bucket = Math.floor(Date.now() / (10 * 60 * 1000))
    const rateLimitKey = `chat-rate:${ipHash}:${bucket}`
    const attempts = Number(await c.env.CART.get(rateLimitKey) ?? '0')
    if (attempts >= 40) {
      return c.json({ error: 'Bạn đã hỏi khá nhiều lần. Hãy đợi một chút để Đi Đâu AI nghỉ ngơi nhé.' }, 429)
    }
    await c.env.CART.put(rateLimitKey, String(attempts + 1), { expirationTtl: 10 * 60 })
  }

  const revision = await c.env.CART.get('tours:revision') ?? '0'
  const cacheKey = `tours:chat_catalog:${revision}`
  let allTours = await c.env.CART.get<Tour[]>(cacheKey, 'json')
  if (!allTours) {
    const { results } = await c.env.DB.prepare(
      'SELECT * FROM tours WHERE active = 1 ORDER BY featured DESC, rating DESC'
    ).all<Tour>()
    allTours = results
    await c.env.CART.put(cacheKey, JSON.stringify(allTours), { expirationTtl: 60 * 10 })
  }

  let reply = ''
  const toursSummary = allTours.map((t) =>
    `[TOUR:${t.id}] "${t.title}" | Địa điểm: ${t.location} | Thể loại: ${t.category} | Thời lượng: ${t.duration} | Giá: ${t.price} VNĐ | Điểm nổi bật: ${t.highlights} | Bao gồm: ${t.included} | Tóm tắt: ${t.summary}`
  ).join('\n')

  const systemPrompt = `Bạn là Cố Vấn Hành Trình AI của nền tảng du lịch "Đi Đâu" (didau.vn).
Phương châm: "Đi chậm hơn. Nhớ lâu hơn."
Phong cách: Thân tình, chu đáo, am hiểu sâu sắc du lịch bản địa Việt Nam, lịch sự và tuyệt đối chuẩn xác.

DANH SÁCH TOÀN BỘ CÁC TOUR DU LỊCH HIỆN CÓ TRÊN WEBSITE ĐI ĐÂU:
${toursSummary}

QUY TẮC PHÂN TÍCH VÀ TRẢ LỜI (BẮT BUỘC TUÂN THỦ 100%):

1. PHẠM VI TƯ VẤN:
- BẠN CHỈ TƯ VẤN VỀ CÁC TOUR DU LỊCH CÓ TRÊN WEBSITE ĐI ĐÂU.
- Tuyệt đối từ chối trả lời các chủ đề ngoài du lịch (ví dụ: lập trình, giải toán, tin tức, chính trị, thời sự, nấu ăn...). Khi khách hỏi ngoài lề, trả lời lịch sự: "Dạ Đi Đâu AI chỉ hỗ trợ tư vấn các tour và trải nghiệm du lịch hiện có trên website Đi Đâu. Rất mong bạn thông cảm! Bạn có thể hỏi mình về các tour du lịch nhé."

2. PHÂN TÍCH KỸ CÂU HỎI TRƯỚC KHI TRẢ LỜI:
- Lắng nghe kỹ xem khách hỏi về địa điểm nào?
- Khách có hỏi mô tả chi tiết địa điểm, trong đó có những danh lam thắng cảnh, sự kiện, điểm tham quan hoặc trải nghiệm nào không?
- Khách có hỏi giá tour không?
- Khách có yêu cầu số ngày cụ thể (ví dụ 3 ngày 2 đêm, 2 ngày 1 đêm) hay ngân sách (ví dụ dưới 3 triệu) không?

3. KHI ĐỊA ĐIỂM/TOUR KHÁCH HỎI CÓ TRÊN WEBSITE:
- MÔ TẢ CHI TIẾT ĐỊA ĐIỂM: Giới thiệu rõ các danh lam thắng cảnh, điểm tham quan, hoạt động hoặc sự kiện trong tour dựa vào thông tin "Điểm nổi bật" và "Tóm tắt" (ví dụ: đèo Mã Pí Lèng, chèo thuyền sông Nho Quế, kayak vịnh Hạ Long, hang Sửng Sốt, lặn san hô An Thới, phố cổ Hội An...).
- NẾU KHÁCH HỎI GIÁ: BẮT BUỘC trả lời đúng 100% theo giá niêm yết trong dữ liệu tour (đơn vị VNĐ hoặc triệu đồng/khách). Tuyệt đối không đoán mò hay nói sai giá.
- NÊU RÕ THỜI LƯỢNG: Ghi chính xác thời lượng (ví dụ: 3 ngày 2 đêm, 2 ngày 1 đêm, 1 ngày).
- LUÔN KÈM MÃ [TOUR:id]: Gắn mã [TOUR:id] ngay sau tên tour (ví dụ: Chinh phục vòng cung Hà Giang [TOUR:1]).

4. KHI ĐỊA ĐIỂM KHÁCH HỎI KHÔNG CÓ TRÊN WEBSITE (Ví dụ: khách hỏi Thái Nguyên, Lạng Sơn, Tuyên Quang, Phú Thọ, Nghệ An, Đắk Nông, Tiền Giang, hoặc các nước Thái Lan, Hàn Quốc, Nhật Bản... hoặc bất kỳ nơi nào Đi Đâu chưa có tour):
- BƯỚC 1 - THÔNG BÁO RÕ RÀNG: BẮT BUỘC trả lời:
  "Dạ hiện tại chưa có tour du lịch [Tên địa điểm] này, chúng tôi sẽ cập nhật sớm và bổ sung thông tin về địa điểm du lịch này!!"
- BƯỚC 2 - CHỦ ĐỘNG GỢI Ý ĐỊA ĐIỂM/TOUR TƯƠNG TỰ CÓ TRÊN WEBSITE:
  Bạn BẮT BUỘC phải gợi ý các tour đang có trên web theo một trong các tiêu chí sau:
  * Gợi ý địa điểm nổi tiếng gần chỗ đó (cùng vùng miền/tỉnh lân cận):
    - Ví dụ: Khách hỏi Thái Nguyên mà web chưa có -> Hãy gợi ý các tỉnh gần đó ở miền Bắc có trên web như Hồ Ba Bể - Bắc Kạn [TOUR:25] (ngay gần Thái Nguyên), Hà Giang [TOUR:1], Sa Pa - Lào Cai [TOUR:4], Cao Bằng - Thác Bản Giốc [TOUR:12], hoặc Ninh Bình [TOUR:5].
    - Ví dụ: Khách hỏi Nghệ An, Hà Tĩnh -> Gợi ý Quảng Bình (Phong Nha [TOUR:34], Hang Én [TOUR:59]), Cố đô Huế [TOUR:10], hoặc Đà Nẵng [TOUR:30].
    - Ví dụ: Khách hỏi Đắk Nông -> Gợi ý Buôn Ma Thuột [TOUR:37], Măng Đen [TOUR:36], Gia Lai [TOUR:58], hoặc Đà Lạt [TOUR:11].
    - Ví dụ: Khách hỏi Tiền Giang, Long An -> Gợi ý Bến Tre [TOUR:44], Cần Thơ [TOUR:14], Đồng Tháp [TOUR:43].
    - Ví dụ: Khách hỏi tour nước ngoài -> Gợi ý các tour biển đảo hoặc danh thắng hàng đầu Việt Nam như Phú Quốc [TOUR:9], Vịnh Hạ Long [TOUR:2], Nha Trang [TOUR:18], Côn Đảo [TOUR:15].
  * Gợi ý tour có cùng số ngày y như khách hỏi (ví dụ khách hỏi 3 ngày 2 đêm -> gợi ý đúng tour 3 ngày 2 đêm trên web).
  * Gợi ý tour có giá tiền tương tự ngân sách khách yêu cầu (ví dụ dưới 3 triệu).
  * Khi gợi ý: Nêu rõ tên tour, thời lượng, giá tiền chính xác, điểm tham quan nổi bật và gắn mã [TOUR:id].

5. ĐỊNH DẠNG VÀ PHONG CÁCH:
- Trả lời bằng tiếng Việt thân tình, tự nhiên, gãy gọn, xuống dòng khoa học.
- BẮT BUỘC gắn mã [TOUR:id] ngay sau tên mỗi tour được nhắc đến để hệ thống hiển thị thẻ tour cho khách xem và đặt.`

  if (c.env.AI && typeof c.env.AI.run === 'function') {
    try {
      const model = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
      console.log('>>> Calling Workers AI with model:', model)
      const aiResponse = await c.env.AI.run(model, {
        messages: [
          { role: 'system', content: systemPrompt },
          ...sanitizedMessages.slice(-6).map((m) => ({ role: m.role, content: m.content })),
        ],
        max_tokens: 600,
        temperature: 0.4,
      }) as { response?: string }
      console.log('>>> Workers AI raw response:', JSON.stringify(aiResponse))
      const rawChoices = (aiResponse as any)?.choices?.[0]?.message
      reply = rawChoices?.content?.trim() ||
              rawChoices?.reasoning_content?.trim() ||
              (aiResponse as any)?.response?.trim() ||
              (aiResponse as any)?.text?.trim() ||
              ''
    } catch (err) {
      console.error('>>> Cloudflare Workers AI execution error:', err)
    }
  }

  if (!reply) {
    reply = generateSmartFallbackReply(userQuery, allTours)
  }

  const suggestedTourIds: number[] = []
  const matches = reply.matchAll(/\[TOUR:(\d+)\]/g)
  for (const match of matches) {
    const id = Number(match[1])
    if (!suggestedTourIds.includes(id) && allTours.some((t) => t.id === id)) {
      suggestedTourIds.push(id)
    }
  }

  if (suggestedTourIds.length === 0) {
    const lowerQ = userQuery.toLowerCase()
    const matched = allTours.find((t) =>
      lowerQ.includes(t.location.toLowerCase()) || lowerQ.includes(t.title.toLowerCase())
    )
    if (matched) suggestedTourIds.push(matched.id)
  }

  const suggestedTours = allTours.filter((t) => suggestedTourIds.includes(t.id))
  const cleanReply = reply.replace(/\[TOUR:(\d+)\]/g, (_match, id, offset, fullStr) => {
    const t = allTours.find((tour) => tour.id === Number(id))
    if (!t) return ''
    const prevChars = fullStr.slice(Math.max(0, offset - 100), offset)
    const nextChars = fullStr.slice(offset + _match.length, offset + _match.length + 100)
    if (prevChars.includes(t.title) || nextChars.includes(t.title)) return ''
    return `"${t.title}"`
  }).replace(/  +/g, ' ').trim()

  return c.json({
    reply: cleanReply,
    suggestedTourIds,
    suggestedTours,
  })
})

app.use('/admin/*', requireAdmin)

app.get('/admin/orders', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT o.*, COALESCE(p.payment_status, 'unpaid') AS payment_status,
            p.payment_method, p.paid_at,
            COALESCE(GROUP_CONCAT(oi.tour_title || ' × ' || oi.quantity, ', '), '') AS items
     FROM orders o
     LEFT JOIN order_items oi ON oi.order_id = o.id
     LEFT JOIN order_payments p ON p.order_id = o.id
     GROUP BY o.id ORDER BY o.created_at DESC LIMIT 200`,
  ).all()
  return c.json(results)
})

app.patch('/admin/orders/:id', async (c) => {
  const body = await readJson<{ status?: string }>(c)
  const statuses = ['pending', 'confirmed', 'cancelled']
  if (!body || !body.status || !statuses.includes(body.status)) {
    return c.json({ error: 'Trạng thái đơn không hợp lệ.' }, 400)
  }
  const result = await c.env.DB.prepare('UPDATE orders SET status = ? WHERE id = ?')
    .bind(body.status, c.req.param('id')).run()
  if (!result.meta.changes) return c.json({ error: 'Không tìm thấy đơn đặt chỗ.' }, 404)
  return c.json({ ok: true })
})

app.get('/admin/tours', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM tours ORDER BY id DESC').all<Tour>()
  return c.json(results)
})

app.post('/admin/tours', async (c) => {
  const body = await readJson<TourInput>(c)
  if (!isTourInput(body)) return c.json({ error: 'Thông tin trải nghiệm chưa hợp lệ.' }, 400)
  try {
    const result = await c.env.DB.prepare(
      `INSERT INTO tours (slug,title,location,category,duration,price,rating,review_count,summary,image,image_alt,highlights,included,featured,active)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(body.slug.trim(), body.title.trim(), body.location.trim(), body.category.trim(), body.duration.trim(),
      body.price, body.rating, body.review_count ?? 0, body.summary.trim(), body.image.trim(), body.image_alt.trim(),
      body.highlights.trim(), body.included.trim(), body.featured, body.active).run()
    await invalidateTours(c)
    return c.json({ id: result.meta.last_row_id }, 201)
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE')) {
      return c.json({ error: 'Đường dẫn trải nghiệm đã tồn tại.' }, 409)
    }
    throw error
  }
})

app.put('/admin/tours/:id', async (c) => {
  const body = await readJson<TourInput>(c)
  if (!isTourInput(body)) return c.json({ error: 'Thông tin trải nghiệm chưa hợp lệ.' }, 400)
  const result = await c.env.DB.prepare(
    `UPDATE tours SET slug=?,title=?,location=?,category=?,duration=?,price=?,rating=?,review_count=?,summary=?,image=?,image_alt=?,highlights=?,included=?,featured=?,active=? WHERE id=?`,
  ).bind(body.slug.trim(), body.title.trim(), body.location.trim(), body.category.trim(), body.duration.trim(),
    body.price, body.rating, body.review_count ?? 0, body.summary.trim(), body.image.trim(), body.image_alt.trim(),
    body.highlights.trim(), body.included.trim(), body.featured, body.active, Number(c.req.param('id'))).run()
  if (!result.meta.changes) return c.json({ error: 'Không tìm thấy trải nghiệm.' }, 404)
  await invalidateTours(c)
  return c.json({ ok: true })
})

app.delete('/admin/tours/:id', async (c) => {
  const result = await c.env.DB.prepare('UPDATE tours SET active = 0 WHERE id = ?')
    .bind(Number(c.req.param('id'))).run()
  if (!result.meta.changes) return c.json({ error: 'Không tìm thấy trải nghiệm.' }, 404)
  await invalidateTours(c)
  return c.json({ ok: true })
})

app.onError((error, c) => {
  console.error('Unhandled API error:', error)
  return c.json({ error: 'Đã xảy ra lỗi máy chủ. Vui lòng thử lại.' }, 500)
})

export default app
