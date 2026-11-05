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

const generateSmartFallbackReply = (query: string, tours: Tour[]): string => {
  const q = query.toLowerCase()
  const budget = parseBudgetFromQuery(q)

  const unsupported = ['thái lan', 'singapore', 'hàn quốc', 'nhật bản', 'châu âu', 'mỹ', 'pháp', 'úc', 'bali', 'bangkok', 'cà mau', 'an giang', 'vũng tàu']
  for (const place of unsupported) {
    if (q.includes(place)) {
      return `Hiện tại Đi Đâu tập trung tuyển chọn các hành trình trải nghiệm bản địa đặc sắc tại các vùng núi phía Bắc, miền Trung, Tây Nguyên và biển đảo Việt Nam nên chưa có tour đi ${place}. Tuy nhiên, nếu bạn yêu thích thiên nhiên và khám phá, Đi Đâu có những hành trình tuyệt vời rất đáng thử như [TOUR:1] hoặc [TOUR:6]!`
    }
  }

  let candidates = tours.filter((t) => t.active === 1)
  if (budget) {
    const withBudget = candidates.filter((t) => t.price <= budget)
    if (withBudget.length > 0) candidates = withBudget
  }

  const locations = [
    'hà giang', 'hạ long', 'hội an', 'sa pa', 'sapa', 'ninh bình', 'phú quốc', 'huế', 'đà lạt',
    'cao bằng', 'quy nhơn', 'cần thơ', 'côn đảo', 'lý sơn', 'phú yên', 'nha trang', 'mai châu',
    'pù luông', 'bạch mã', 'kon tum', 'ba bể', 'cúc phương', 'tà xùa', 'hà nội', 'mỹ sơn',
  ]
  const matchedLoc = locations.find((loc) => q.includes(loc))
  if (matchedLoc) {
    const byLoc = candidates.filter((t) =>
      t.location.toLowerCase().includes(matchedLoc) ||
      t.title.toLowerCase().includes(matchedLoc) ||
      (matchedLoc === 'sapa' && t.location.toLowerCase().includes('lào cai'))
    )
    if (byLoc.length > 0) candidates = byLoc
  } else if (q.includes('biển') || q.includes('đảo') || q.includes('lặn')) {
    const bySea = candidates.filter((t) => t.category === 'Biển đảo' || t.title.toLowerCase().includes('biển') || t.highlights.toLowerCase().includes('san hô'))
    if (bySea.length > 0) candidates = bySea
  } else if (q.includes('săn mây') || q.includes('leo núi') || q.includes('trekking') || q.includes('núi') || q.includes('phiêu lưu')) {
    const byAdv = candidates.filter((t) => t.category === 'Phiêu lưu' || t.summary.toLowerCase().includes('mây') || t.highlights.toLowerCase().includes('săn mây'))
    if (byAdv.length > 0) candidates = byAdv
  } else if (q.includes('nghỉ dưỡng') || q.includes('thư giãn') || q.includes('resort') || q.includes('an yên')) {
    const byRetreat = candidates.filter((t) => t.category === 'Nghỉ dưỡng')
    if (byRetreat.length > 0) candidates = byRetreat
  } else if (q.includes('văn hóa') || q.includes('lịch sử') || q.includes('phố cổ') || q.includes('ẩm thực')) {
    const byCulture = candidates.filter((t) => t.category === 'Văn hóa')
    if (byCulture.length > 0) candidates = byCulture
  }

  const selected = candidates.slice(0, 2)
  if (selected.length === 0) {
    return 'Dạ Đi Đâu có rất nhiều chuyến đi thiên nhiên, văn hóa và biển đảo đặc sắc. Bạn có thể tham khảo hành trình [TOUR:1] hoặc [TOUR:3] nhé!'
  }

  const intro = budget
    ? 'Dưới đây là hành trình phù hợp với ngân sách của bạn:'
    : 'Dạ, để bạn cảm nhận trọn vẹn vẻ đẹp bản địa, Đi Đâu gợi ý cho bạn hành trình:'

  const list = selected.map((t) =>
    `• [TOUR:${t.id}] **${t.title}** (${t.location} · ${t.duration} · ${new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(t.price)}): ${t.summary}`
  ).join('\n\n')

  return `${intro}\n\n${list}\n\nBạn có thể nhấn nút "+ Thêm vào chuyến đi" ngay dưới thẻ tour để giữ lịch trước nhé!`
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

  const systemPrompt = `Bạn là Trợ lý Cố vấn Hành trình của nền tảng du lịch "Đi Đâu" (didau.vn).
Phương châm: "Đi chậm hơn. Nhớ lâu hơn."
Phong cách: Thân tình, ấm áp, văn minh, ngắn gọn, giàu cảm hứng trải nghiệm bản địa Việt Nam.

DANH SÁCH TOÀN BỘ CÁC TOUR CÓ THẬT TRÊN WEBSITE ĐI ĐÂU:
${toursSummary}

QUY TẮC BẮT BUỘC (TUÂN THỦ 100%):
1. BẠN CHỈ ĐƯỢC GỢI Ý các tour có trong danh sách trên. TUYỆT ĐỐI KHÔNG tự bịa tour, không gợi ý tour đi nước ngoài hoặc các địa điểm Đi Đâu chưa có.
2. Khi giới thiệu bất kỳ tour nào, BẮT BUỘC phải viết mã [TOUR:id] ngay sau tên tour (ví dụ: Chinh phục vòng cung Hà Giang [TOUR:1]).
3. Nếu người dùng hỏi điểm đến mà Đi Đâu chưa có (ví dụ: Cà Mau, tour nước ngoài, Thái Lan, châu Âu...), hãy lịch sự trả lời rằng Đi Đâu hiện chưa có hành trình tại địa điểm đó, sau đó gợi ý 1-2 hành trình tương tự hiện có trên website.
4. Lắng nghe kỹ yêu cầu về ngân sách, số ngày đi và phong cách (nghỉ dưỡng, văn hóa, phiêu lưu, săn mây...) để gợi ý từ 1 đến 3 tour phù hợp nhất.
5. Trả lời bằng tiếng Việt tự nhiên, súc tích, dễ đọc.`

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
