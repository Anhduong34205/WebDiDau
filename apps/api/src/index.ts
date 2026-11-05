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

  // 1. Kiểm tra câu hỏi ngoài phạm vi tour/du lịch
  const nonTravelTopics = [
    'lập trình', 'code', 'python', 'javascript', 'html', 'css', 'toán', 'vật lý', 'hóa học',
    'chính trị', 'tin tức', 'thời sự', 'chứng khoán', 'crypto', 'bitcoin', 'thời tiết hôm nay',
    'dịch thuật', 'bóng đá', 'nấu ăn'
  ]
  if (nonTravelTopics.some((topic) => q.includes(topic))) {
    return 'Dạ chào bạn! Đi Đâu AI được thiết kế chuyên biệt để đồng hành và tư vấn các hành trình du lịch bản địa tuyệt đẹp trên website Đi Đâu. Về chủ đề này mình chưa thể hỗ trợ bạn được rồi, rất mong bạn thông cảm nhé! Nếu bạn đang ấp ủ kế hoạch cho một chuyến du ngoạn biển đảo xanh biếc hay lên non ngắm mây để nạp lại năng lượng, bạn cứ nhắn cho mình biết để cùng lên kế hoạch nhé!'
  }

  const isAskingPrice = /(?:giá|bao nhiêu tiền|hết bao nhiêu|chi phí|mấy tiền|giá vé|vé bao nhiêu)/i.test(q)
  const isAskingDetails = /(?:chi tiết|mô tả|có gì|có những gì|tham quan|danh lam|thắng cảnh|địa điểm nào|sự kiện|chơi gì|trải nghiệm)/i.test(q)

  // Phát hiện thời lượng nếu khách yêu cầu
  let targetDuration = ''
  if (/3\s*ngày\s*2\s*đêm|3n2đ|3n2d/i.test(q)) targetDuration = '3 ngày 2 đêm'
  else if (/2\s*ngày\s*1\s*đêm|2n1đ|2n1d/i.test(q)) targetDuration = '2 ngày 1 đêm'
  else if (/1\s*ngày|trong ngày|ngay trong ngay/i.test(q)) targetDuration = '1 ngày'
  else if (/5\s*ngày\s*4\s*đêm|5n4đ|5n4d/i.test(q)) targetDuration = '5 ngày 4 đêm'

  const activeTours = tours.filter((t) => t.active === 1)

  // 2. Ưu tiên kiểm tra các địa điểm CHƯA CÓ TRÊN WEB
  type NeighborMapping = {
    keywords: string[]
    name: string
    suggestedQuery: (t: Tour) => boolean
    suggestedLocNames: string
    introReason: string
  }

  const neighborMappings: NeighborMapping[] = [
    {
      keywords: ['thái nguyên', 'thai nguyen', 'tuyên quang', 'tuyen quang', 'lạng sơn', 'lang son', 'bắc giang', 'bac giang', 'phú thọ', 'phu tho', 'vĩnh phúc', 'vinh phuc', 'hải dương', 'hai duong', 'hưng yên', 'hung yen', 'thái bình', 'thai binh', 'nam định', 'nam dinh', 'hà nam', 'ha nam'],
      name: 'Thái Nguyên / lân cận miền Bắc',
      suggestedQuery: (t) => ['Bắc Kạn', 'Cao Bằng', 'Hà Giang', 'Ninh Bình', 'Lào Cai'].includes(t.location),
      suggestedLocNames: 'Bắc Kạn (Hồ Ba Bể), Hà Giang, Cao Bằng (Thác Bản Giốc), Ninh Bình (Tràng An) hoặc Sa Pa',
      introReason: 'không gian núi rừng trong trẻo, sông nước thanh bình và nét văn hóa vùng cao mộc mạc'
    },
    {
      keywords: ['nghệ an', 'nghe an', 'hà tĩnh', 'ha tinh', 'quảng trị', 'quang tri'],
      name: 'Bắc Trung Bộ',
      suggestedQuery: (t) => ['Quảng Bình', 'Huế', 'Đà Nẵng'].some((l) => t.location.includes(l)),
      suggestedLocNames: 'Quảng Bình (Phong Nha, Hang Én), Cố đô Huế trầm mặc hoặc thành phố biển Đà Nẵng',
      introReason: 'dải đất di sản miền Trung tráng lệ, nơi kết hợp giữa kỳ quan hang động và chiều sâu lịch sử'
    },
    {
      keywords: ['đắk nông', 'dak nong', 'đắc nông', 'tà đùng', 'ta dung'],
      name: 'Đắk Nông',
      suggestedQuery: (t) => ['Đắk Lắk', 'Kon Tum', 'Lâm Đồng', 'Gia Lai'].includes(t.location),
      suggestedLocNames: 'Buôn Ma Thuột (Đắk Lắk), Măng Đen sương mù (Kon Tum) hoặc Đà Lạt thông reo',
      introReason: 'hương vị cà phê nồng nàn, tiếng cồng chiêng vang vọng giữa đại ngàn và không khí se lạnh tuyệt vời'
    },
    {
      keywords: ['tiền giang', 'tien giang', 'vĩnh long', 'vinh long', 'trà vinh', 'tra vinh', 'hậu giang', 'hau giang', 'sóc trăng', 'soc trang', 'bạc liêu', 'bac lieu', 'long an'],
      name: 'miền Tây lân cận',
      suggestedQuery: (t) => ['Cần Thơ', 'Bến Tre', 'Đồng Tháp', 'An Giang', 'Cà Mau'].includes(t.location),
      suggestedLocNames: 'Bến Tre (Xứ dừa nước), Cần Thơ (Chợ nổi Cái Răng), Đồng Tháp (Xứ sen) hoặc An Giang (Rừng tràm Trà Sư)',
      introReason: 'nhịp sống êm ả trên sông nước phương Nam, những vườn cây trĩu quả và lòng hiếu khách của người bản địa'
    },
    {
      keywords: ['thái lan', 'thailand', 'singapore', 'hàn quốc', 'korea', 'nhật bản', 'japan', 'châu âu', 'mỹ', 'bali', 'tokyo', 'seoul', 'bangkok'],
      name: 'nước ngoài',
      suggestedQuery: (t) => ['Kiên Giang', 'Quảng Ninh', 'Khánh Hòa', 'Đà Nẵng'].includes(t.location),
      suggestedLocNames: 'Đảo ngọc Phú Quốc, Vịnh Hạ Long di sản thế giới, vịnh biển Nha Trang hoặc thiên đường nghỉ dưỡng Đà Nẵng',
      introReason: 'cảnh sắc thiên nhiên di sản hùng vĩ cùng hệ thống resort nghỉ dưỡng đẳng cấp quốc tế ngay tại dải đất hình chữ S'
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
      `• [TOUR:${t.id}] **${t.title}** (${t.location} · ${t.duration} · Giá niêm yết: **${formatVND(t.price)}/khách**)\n  - 📍 *Điểm đến nổi bật:* ${t.highlights}\n  - 🌿 *Hồn cốt chuyến đi:* ${t.summary}\n  - 🎒 *Dịch vụ trọn gói:* ${t.included}`
    ).join('\n\n')

    return `Dạ chào bạn, rất cảm ơn bạn đã quan tâm và chia sẻ cùng Đi Đâu về điểm đến **${placeWord}**! Hiện tại chưa có tour du lịch ${placeWord} này, chúng tôi sẽ cập nhật sớm và bổ sung thông tin về địa điểm du lịch này để phục vụ bạn trong thời gian tới nhé!!\n\nTuy vậy, nếu bạn đang tìm kiếm một chuyến đi để cảm nhận ${matchedNeighbor.introReason}, Đi Đâu xin gợi ý bạn những vùng đất nổi tiếng gần chỗ đó (${matchedNeighbor.suggestedLocNames}) với lịch trình vô cùng chỉn chu và dịch vụ bản địa ấm áp đang có sẵn trên website:\n\n${pickList}\n\n💡 **Lời khuyên từ Đi Đâu:** Các hành trình này đều có đội ngũ hướng dẫn viên địa phương tận tâm chăm sóc từ bữa ăn đến nơi lưu trú. Bạn có thể nhấn vào thẻ tour bên dưới để xem thêm hình ảnh thực tế và chọn ngày khởi hành phù hợp nhất nhé!`
  }

  // 3. Tính điểm khớp tour chính xác
  const scoredTours = activeTours.map((t) => {
    let score = 0
    const loc = t.location.toLowerCase()
    const title = t.title.toLowerCase()
    const hl = t.highlights.toLowerCase()

    if (q.includes(title)) score += 20
    if (title.includes('tràng an') && q.includes('tràng an')) score += 15
    if (title.includes('cúc phương') && q.includes('cúc phương')) score += 15
    if (title.includes('sơn trà') && (q.includes('sơn trà') || q.includes('linh ứng') || q.includes('bàn cờ'))) score += 15
    if (title.includes('hội an') && q.includes('hội an')) score += 15
    if (title.includes('mỹ sơn') && q.includes('mỹ sơn')) score += 15
    if (title.includes('bà nà') && (q.includes('bà nà') || q.includes('cầu vàng'))) score += 15
    if (title.includes('phong nha') && q.includes('phong nha')) score += 15
    if (title.includes('hang én') && q.includes('hang én')) score += 15
    if (title.includes('hạ long') && q.includes('hạ long')) score += 15
    if (title.includes('bình liêu') && q.includes('bình liêu')) score += 15
    if (title.includes('hà giang') && q.includes('hà giang')) score += 15
    if (title.includes('quản bạ') && q.includes('quản bạ')) score += 15
    if (title.includes('mù cang chải') && q.includes('mù cang chải')) score += 15
    if (title.includes('măng đen') && q.includes('măng đen')) score += 15
    if (title.includes('buôn ma thuột') && (q.includes('buôn ma thuột') || q.includes('hồ lắk'))) score += 15
    if (title.includes('biển hồ') && (q.includes('biển hồ') || q.includes('chư đăng ya') || q.includes('pleiku'))) score += 15
    if (title.includes('vĩnh hy') && (q.includes('vĩnh hy') || q.includes('hang rái'))) score += 15
    if (title.includes('mũi né') && (q.includes('mũi né') || q.includes('phan thiết'))) score += 15
    if (title.includes('nam du') && q.includes('nam du')) score += 15
    if (title.includes('phú quốc') && q.includes('phú quốc')) score += 15
    if (title.includes('côn đảo') && q.includes('côn đảo')) score += 15
    if (title.includes('vũng tàu') && q.includes('vũng tàu')) score += 15
    if (title.includes('đà lạt') && (q.includes('đà lạt') || q.includes('tuyền lâm'))) score += 15
    if (title.includes('tây ninh') && (q.includes('tây ninh') || q.includes('bà đen'))) score += 15
    if (title.includes('bến tre') && q.includes('bến tre')) score += 15
    if (title.includes('đồng tháp') && (q.includes('đồng tháp') || q.includes('tràm chim') || q.includes('tháp mười'))) score += 15
    if (title.includes('cà mau') && (q.includes('cà mau') || q.includes('đất mũi'))) score += 15
    if (title.includes('an giang') && (q.includes('trà sư') || q.includes('châu đốc'))) score += 15
    if (title.includes('cần thơ') && (q.includes('cần thơ') || q.includes('cái răng'))) score += 15
    if (title.includes('lan hạ') && (q.includes('lan hạ') || q.includes('cát bà'))) score += 15
    if (title.includes('ba bể') && (q.includes('ba bể') || q.includes('bắc kạn'))) score += 15
    if (title.includes('tả van') && (q.includes('sa pa') || q.includes('sapa') || q.includes('tả van'))) score += 15

    if (q.includes(loc)) score += 5
    if (loc.includes('lâm đồng') && (q.includes('đà lạt') || q.includes('da lat'))) score += 8
    if (loc.includes('lào cai') && (q.includes('sa pa') || q.includes('sapa') || q.includes('fansipan'))) score += 8
    if (loc.includes('quảng ninh') && (q.includes('hạ long') || q.includes('bình liêu'))) score += 8
    if (loc.includes('kiên giang') && (q.includes('phú quốc') || q.includes('nam du'))) score += 8
    if (loc.includes('bà rịa') && (q.includes('vũng tàu') || q.includes('côn đảo'))) score += 8
    if (loc.includes('quảng nam') && (q.includes('hội an') || q.includes('mỹ sơn'))) score += 8
    if (loc.includes('quảng bình') && (q.includes('phong nha') || q.includes('hang én'))) score += 8
    if (loc.includes('khánh hòa') && (q.includes('nha trang') || q.includes('cam ranh'))) score += 8
    if (loc.includes('bình định') && (q.includes('quy nhơn') || q.includes('kỳ co'))) score += 8
    if (loc.includes('ninh bình') && (q.includes('tràng an') || q.includes('cúc phương'))) score += 8
    if (loc.includes('kon tum') && (q.includes('măng đen') || q.includes('kon tum'))) score += 8
    if (loc.includes('đà nẵng') && q.includes('đà nẵng')) score += 8

    if (q.includes('đèn lồng') && hl.includes('đèn lồng')) score += 6
    if (q.includes('săn mây') && (hl.includes('săn mây') || title.includes('săn mây'))) score += 6
    if (q.includes('lặn') && (hl.includes('lặn') || title.includes('lặn'))) score += 6

    return { tour: t, score }
  })

  scoredTours.sort((a, b) => b.score - a.score)
  const bestMatch = scoredTours[0]?.score > 0 ? scoredTours[0].tour : null

  if (bestMatch) {
    if (isAskingPrice && !isAskingDetails) {
      return `Dạ chào bạn, Đi Đâu rất vui được giải đáp chi phí hành trình cùng bạn!\n\nTour **${bestMatch.title}** [TOUR:${bestMatch.id}] hiện có mức giá niêm yết chính xác là **${formatVND(bestMatch.price)}/khách** với lịch trình trọn vẹn **${bestMatch.duration}**.\n\n📍 **Những danh thắng & trải nghiệm bạn sẽ đi qua:** ${bestMatch.highlights}\n✨ **Dịch vụ chu đáo đã bao gồm trong giá vé:** ${bestMatch.included}\n\n💡 **Gợi ý nhỏ:** Đây là mức giá trọn gói minh bạch, không phụ thu ẩn. Nếu bạn đi theo nhóm gia đình hoặc bạn bè, Đi Đâu luôn có những góc phòng và vị trí ngắm cảnh đẹp nhất dành cho đoàn. Bạn có thể nhấn trực tiếp vào thẻ tour bên dưới để giữ chỗ ngay nhé!`
    }
    return `Dạ chào bạn, thật tuyệt vời khi bạn đang quan tâm đến hành trình khám phá **${bestMatch.location}**!\n\nHiện tại trên website Đi Đâu đang có tour **${bestMatch.title}** [TOUR:${bestMatch.id}] với thời lượng **${bestMatch.duration}** (giá niêm yết chuẩn: **${formatVND(bestMatch.price)}/khách**), được rất nhiều du khách yêu thích:\n\n🌿 **Cảm hứng hành trình:** ${bestMatch.summary}\n📍 **Các danh lam thắng cảnh & trải nghiệm đặc sắc:** ${bestMatch.highlights}\n✨ **Dịch vụ chăm sóc trọn gói bao gồm:** ${bestMatch.included}\n\n💡 **Lời khuyên du lịch:** Khi tham gia hành trình này, bạn nhớ chuẩn bị trang phục thoải mái, mang theo áo ấm nhẹ hoặc mũ nón phù hợp theo mùa để thỏa sức ghi lại những bức ảnh kỷ niệm đắt giá. Bạn có thể nhấn vào thẻ tour bên dưới để xem thêm thông tin chi tiết hoặc đặt giữ chỗ trước nhé!`
  }

  // 4. Nếu hỏi theo thời lượng
  if (targetDuration) {
    let durMatches = activeTours.filter((t) => t.duration.toLowerCase().includes(targetDuration.toLowerCase()))
    if (budget) {
      const withBud = durMatches.filter((t) => t.price <= budget)
      if (withBud.length > 0) durMatches = withBud
    }
    const picks = durMatches.slice(0, 3)
    if (picks.length > 0) {
      const pickList = picks.map((t) =>
        `• [TOUR:${t.id}] **${t.title}** (${t.location} · ${t.duration} · **${formatVND(t.price)}/khách**)\n  - 📍 *Điểm tham quan:* ${t.highlights}\n  - 🌿 *Trải nghiệm:* ${t.summary}`
      ).join('\n\n')
      return `Dạ chào bạn, với quỹ thời gian đúng **${targetDuration}**${budget ? ' cùng ngân sách ' + formatVND(budget) : ''}, Đi Đâu đã chọn lọc những hành trình lý tưởng nhất để bạn vừa tận hưởng trọn vẹn cảnh sắc vừa không phải di chuyển quá gấp gáp:\n\n${pickList}\n\n💡 Bạn có thể bấm vào thẻ từng tour bên dưới để xem chi tiết lịch trình từng ngày và chọn cho mình chuyến đi ưng ý nhất nhé!`
    }
  }

  // 5. Nếu hỏi theo ngân sách hoặc thể loại
  let candidates = [...activeTours]
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
    const hasIntent = ['tour', 'đi', 'ở', 'tại', 'du lịch', 'khám phá', 'chuyến đi', 'địa điểm', 'tỉnh'].some((k) => q.includes(k))
    if (hasIntent) {
      const picks = candidates.slice(0, 2)
      const pickList = picks.map((t) =>
        `• [TOUR:${t.id}] **${t.title}** (${t.location} · ${t.duration} · **${formatVND(t.price)}/khách**)\n  - 📍 *Điểm tham quan:* ${t.highlights}\n  - 🌿 *Trải nghiệm:* ${t.summary}`
      ).join('\n\n')
      return `Dạ chào bạn, rất cảm ơn bạn đã nhắn tin cho Đi Đâu! Hiện tại chưa có tour du lịch tại địa điểm này, chúng tôi sẽ cập nhật sớm và bổ sung thông tin về địa điểm du lịch này để phục vụ bạn tốt hơn nhé!!\n\nTuy nhiên, để bạn có thêm nhiều nguồn cảm hứng xê dịch, Đi Đâu xin gợi ý bạn những hành trình đặc sắc và giàu trải nghiệm bản địa đang có sẵn trên website:\n\n${pickList}\n\nBạn hãy tham khảo và nhấn vào thẻ tour bên dưới để tìm hiểu thêm nhé!`
    }
  }

  const selected = candidates.slice(0, 2)
  if (selected.length === 0) {
    return 'Dạ chào bạn, hiện tại chưa có tour du lịch này, chúng tôi sẽ cập nhật sớm và bổ sung thông tin về địa điểm du lịch này!! Bạn có thể tham khảo các hành trình đặc sắc khác đang có trên website Đi Đâu nhé, mình luôn sẵn sàng đồng hành cùng bạn!'
  }

  const intro = budget
    ? `Dạ chào bạn, với mức ngân sách tầm **${formatVND(budget)}**, Đi Đâu xin gợi ý cho bạn những hành trình chất lượng và trọn vẹn nhất:`
    : 'Dạ chào bạn! Để bạn cảm nhận trọn vẹn vẻ đẹp bản địa đúng theo tinh thần "Đi chậm hơn, nhớ lâu hơn", Đi Đâu xin gợi ý hành trình tuyệt vời sau:'

  const list = selected.map((t) =>
    `• [TOUR:${t.id}] **${t.title}** (${t.location} · ${t.duration} · **${formatVND(t.price)}/khách**)\n  - 📍 *Điểm tham quan:* ${t.highlights}\n  - 🌿 *Trải nghiệm:* ${t.summary}`
  ).join('\n\n')

  return `${intro}\n\n${list}\n\n💡 Bạn có thể bấm vào thẻ tour ngay bên dưới để kiểm tra ngày đi và đặt giữ chỗ sớm nhé!`
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
    const rateLimitKey = `chat-rate-v2:${ipHash}:${bucket}`
    const attempts = Number(await c.env.CART.get(rateLimitKey) ?? '0')
    if (attempts >= 250) {
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

  const systemPrompt = `Bạn là "Cố Vấn Hành Trình Đi Đâu" – một người bạn đồng hành am hiểu sâu sắc về văn hóa, thiên nhiên và trải nghiệm bản địa Việt Nam của nền tảng du lịch "Đi Đâu" (didau.vn).
Triết lý cốt lõi: "Đi chậm hơn. Nhớ lâu hơn."

PHONG CÁCH TƯ VẤN & NGHỆ THUẬT GIAO TIẾP (BẮT BUỘC):
- **Ấm áp, thân tình, chu đáo**: Luôn xưng hô thân mật "mình" và "bạn", hoặc "Đi Đâu" và "bạn". Tuyệt đối không trả lời cộc lốc, không "hỏi đâu trả lời đấy" khô khan. Hãy mở đầu bằng lời chào niềm nở, chia sẻ tình cảm và sự hào hứng về vùng đất khách đang quan tâm.
- **Văn phong mượt mà, sâu sắc, giàu chất liệu cảm xúc**: Hãy miêu tả sống động vẻ đẹp cảnh quan (dòng sông xanh màu ngọc bích, tiếng gió luồn qua rặng thông, biển mây bồng bềnh lúc bình minh, chén trà bản địa ấm nồng bên bếp lửa...). Kể cho khách nghe về hành trình như một trải nghiệm đáng sống.
- **ĐỘ DÀI CÂU TRẢ LỜI ĐẦY ĐẶN & CHI TIẾT**: Hãy viết câu trả lời dài, đầy đủ (khoảng 3 - 5 đoạn văn mạch lạc), kết hợp hài hòa giữa chất văn miêu tả truyền cảm hứng và thông tin thực tế chuẩn xác.
- **Tính logic & Tính hữu ích**: Luôn cung cấp đầy đủ: Tên tour, thời lượng, giá tiền niêm yết chuẩn xác, danh lam thắng cảnh, hoạt động nổi bật, dịch vụ bao gồm, và đính kèm 1-2 mẹo nhỏ hữu ích (thời điểm check-in đẹp nhất, trang phục, đồ đạc cần mang...). Kết thúc bằng lời gợi mở ân cần để khách dễ dàng hỏi thêm.

DANH SÁCH TOÀN BỘ CÁC TOUR DU LỊCH ĐANG CÓ TRÊN WEBSITE ĐI ĐÂU:
${toursSummary}

QUY TẮC BẮT BUỘC:

1. PHẠM VI TƯ VẤN:
- CHỈ tư vấn về các tour du lịch có trong danh sách trên của website Đi Đâu.
- Khi khách hỏi ngoài lề (viết code, giải toán, chính trị, tin tức, nấu ăn...): Từ chối khéo léo, duyên dáng và ấm áp: "Dạ chào bạn, Đi Đâu AI được tạo ra để chuyên tâm đồng hành và tư vấn các hành trình du lịch tuyệt đẹp trên website Đi Đâu. Về chủ đề này mình chưa thể hỗ trợ được rồi, rất mong bạn thông cảm nhé! Nếu bạn đang muốn tìm một chuyến đi biển đảo hay lên non hít thở không khí trong lành để đổi gió cuối tuần, bạn cứ nhắn cho mình biết nhé!"

2. KHI ĐỊA ĐIỂM/TOUR KHÁCH HỎI CÓ TRÊN WEBSITE:
Hãy triển khai câu trả lời đầy đặn, mượt mà theo cấu trúc:
- **Lời chào & Đồng điệu cảm xúc**: Bày tỏ sự hào hứng với điểm đến của khách (ví dụ: "Chào bạn, Hà Giang luôn là một cung đường huyền thoại mà bất kỳ ai yêu thiên nhiên cũng nên đặt chân đến một lần trong đời...").
- **Mô tả chi tiết bức tranh trải nghiệm**: Khắc họa rõ nét các danh lam thắng cảnh, điểm tham quan, hoạt động độc đáo dựa vào "Điểm nổi bật" và "Tóm tắt" (ví dụ: đèo Mã Pí Lèng, chèo thuyền sông Nho Quế, kayak vịnh Hạ Long, hang Sửng Sốt, lặn san hô An Thới, phố cổ Hội An...).
- **Thông tin minh bạch & Báo giá chuẩn xác**: Nêu chính xác thời lượng (3 ngày 2 đêm, 2 ngày 1 đêm, 1 ngày) và BẮT BUỘC báo đúng 100% giá niêm yết từ dữ liệu (đơn vị VNĐ hoặc triệu đồng). Liệt kê các dịch vụ đã bao gồm trong tour (xe cộ đưa đón, khách sạn/homestay, các bữa ăn đặc sản, vé tham quan, hướng dẫn viên...).
- **Mẹo nhỏ bản địa & Lời kết**: Chia sẻ mẹo hữu ích (trang phục, thời tiết, góc chụp ảnh đẹp), và mời khách bấm vào thẻ tour bên dưới hoặc trò chuyện tiếp nếu muốn hỗ trợ thêm.
- LUÔN GẮN MÃ [TOUR:id] ngay sau tên tour (ví dụ: Chinh phục vòng cung Hà Giang [TOUR:1]).

3. KHI ĐỊA ĐIỂM KHÁCH HỎI CHƯA CÓ TRÊN WEBSITE (Ví dụ: hỏi Thái Nguyên, Lạng Sơn, Tuyên Quang, Bắc Giang, Phú Thọ, Nghệ An, Đắk Nông, Tiền Giang, hoặc các nước ngoài như Thái Lan, Nhật Bản, Hàn Quốc...):
Không bao giờ từ chối cộc lốc! Hãy áp dụng quy tắc 3 bước tinh tế:
- **Bước 1 - Lời chào & Thông báo chuẩn mực**:
  "Dạ chào bạn, rất cảm ơn bạn đã quan tâm và chia sẻ về [Tên địa điểm]! Hiện tại chưa có tour du lịch [Tên địa điểm] này, chúng tôi sẽ cập nhật sớm và bổ sung thông tin về địa điểm du lịch này để phục vụ bạn trong thời gian tới nhé!!"
- **Bước 2 - Chuyển ý mượt mà & Đồng cảm**:
  "Tuy Đi Đâu chưa mở tuyến riêng tại [Tên địa điểm], nhưng nếu bạn đang tìm kiếm một chuyến đi để hòa mình vào cảnh sắc thiên nhiên trong lành, thư giãn và tìm lại sự bình yên, Đi Đâu rất muốn gợi ý cho bạn những hành trình nổi tiếng gần chỗ đó (cùng vùng miền/tỉnh lân cận) đang có sẵn trên website với chất lượng dịch vụ rất chu đáo:"
- **Bước 3 - Giới thiệu sâu sắc các tour lân cận / tương tự**:
  * Nếu hỏi các tỉnh Đông Bắc/miền núi phía Bắc (Thái Nguyên, Lạng Sơn, Tuyên Quang, Phú Thọ...): Gợi ý các tỉnh gần đó có trên web như Bắc Kạn (Hồ Ba Bể [TOUR:25] cách Thái Nguyên chỉ hơn 100km, mặt hồ xanh biếc giữa núi rừng), Chinh phục Hà Giang [TOUR:1], Sa Pa - Lào Cai [TOUR:4], Thác Bản Giốc - Cao Bằng [TOUR:12], hoặc Trôi giữa non nước Tràng An - Ninh Bình [TOUR:5].
  * Nếu hỏi Bắc Trung Bộ (Nghệ An, Hà Tĩnh, Quảng Trị): Gợi ý Quảng Bình (Phong Nha [TOUR:34], Hang Én [TOUR:59]), Cố đô Huế [TOUR:10], Đà Nẵng [TOUR:30].
  * Nếu hỏi Tây Nguyên lân cận (Đắk Nông, Tà Đùng): Gợi ý Buôn Ma Thuột [TOUR:37], Măng Đen - Kon Tum [TOUR:36], Gia Lai [TOUR:58], Đà Lạt [TOUR:11].
  * Nếu hỏi Miền Tây lân cận (Tiền Giang, Long An, Bạc Liêu...): Gợi ý Bến Tre [TOUR:44], Cần Thơ [TOUR:14], Đồng Tháp [TOUR:43], Cà Mau [TOUR:42].
  * Nếu hỏi tour nước ngoài: Gợi ý các tour biển đảo và di sản thiên nhiên thế giới hàng đầu Việt Nam như Phú Quốc [TOUR:9], Vịnh Hạ Long [TOUR:2], Nha Trang [TOUR:18], Côn Đảo [TOUR:15].
  * Nêu rõ tên tour, thời lượng, giá tiền chính xác, điểm tham quan nổi bật và gắn mã [TOUR:id].
- Mời bạn tham khảo thẻ tour bên dưới và luôn sẵn lòng giải đáp thêm mọi thắc mắc.

4. BẮT BUỘC gắn mã [TOUR:id] ngay sau tên tour để giao diện hiển thị thẻ tour tương tác.`

  if (c.env.AI && typeof c.env.AI.run === 'function') {
    try {
      const model = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
      console.log('>>> Calling Workers AI with model:', model)
      const aiResponse = await c.env.AI.run(model, {
        messages: [
          { role: 'system', content: systemPrompt },
          ...sanitizedMessages.slice(-6).map((m) => ({ role: m.role, content: m.content })),
        ],
        max_tokens: 1200,
        temperature: 0.45,
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
