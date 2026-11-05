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
    return 'Dạ Đi Đâu AI chỉ hỗ trợ tư vấn các tour và trải nghiệm du lịch hiện có trên website Đi Đâu thôi ạ. Rất mong bạn thông cảm nhé! Bạn có thể hỏi mình về các hành trình du lịch biển đảo, vùng cao hay văn hóa bản địa đang có trên website nhé.'
  }

  const activeTours = tours.filter((t) => t.active === 1)

  // 2. Nhận diện và đính chính nhầm lẫn địa lý một cách thông minh, tự nhiên theo chuẩn phong cách Đi Đâu
  if (q.includes('mộc châu') && (q.includes('hà giang') || q.includes('ở đâu') || q.includes('thuộc tỉnh'))) {
    const mocChauTour = activeTours.find((t) => t.slug === 'moc-chau-tea-hills') || activeTours.find((t) => t.title.toLowerCase().includes('mộc châu') && t.location.toLowerCase().includes('sơn la')) || activeTours.find((t) => t.title.toLowerCase().includes('mộc châu'))
    const muCangChaiTour = activeTours.find((t) => t.slug === 'mu-cang-chai-harvest') || activeTours.find((t) => t.title.toLowerCase().includes('mù cang chải'))
    let res = 'Mộc Châu là một điểm đến tuyệt vời! Tuy nhiên, Mộc Châu lại thuộc tỉnh Sơn La, chứ không phải Hà Giang. Nếu bạn đang tìm kiếm một chuyến đi đến Mộc Châu, mình có thể gợi ý cho bạn:'
    if (mocChauTour) {
      res += `\n\n${mocChauTour.title} [TOUR:${mocChauTour.id}] - Đây là một hành trình ${mocChauTour.duration} để bạn khám phá vẻ đẹp của Mộc Châu, với những đồi chè xanh mướt, thung lũng mận Nà Ka mùa nở hoa trắng xóa và trải nghiệm nếp sống mộc mạc người Thái ở bản Áng.`
    }
    if (muCangChaiTour) {
      res += `\n\nHoặc nếu bạn muốn khám phá thêm các điểm đến khác gần Mộc Châu, mình cũng có thể gợi ý:\n\n${muCangChaiTour.title} [TOUR:${muCangChaiTour.id}] - Một hành trình ${muCangChaiTour.duration} để bạn chiêm ngưỡng vẻ đẹp của những thửa ruộng bậc thang vàng rực rỡ tại Mù Cang Chải, thuộc tỉnh Yên Bái.`
    }
    res += '\n\nHãy cho mình biết bạn quan tâm đến điểm đến nào hơn, hoặc nếu bạn cần thêm thông tin về các tour khác!'
    return res
  }

  if ((q.includes('sa pa') || q.includes('sapa')) && q.includes('hà giang')) {
    const sapaTour = activeTours.find((t) => t.slug === 'sapa-cloud-hunting') || activeTours.find((t) => t.location.includes('Lào Cai'))
    const hgTour = activeTours.find((t) => t.slug === 'ha-giang-loop') || activeTours.find((t) => t.location.includes('Hà Giang'))
    let res = 'Sa Pa và Hà Giang đều là những tuyệt tác của vùng núi phía Bắc! Tuy nhiên, Sa Pa thuộc tỉnh Lào Cai, còn Hà Giang là một tỉnh riêng biệt bạn nhé. Nếu bạn đang lên kế hoạch cho hành trình vùng cao, mình có thể gợi ý:'
    if (sapaTour) {
      res += `\n\n${sapaTour.title} [TOUR:${sapaTour.id}] - Hành trình ${sapaTour.duration} đưa bạn đắm chìm trong vẻ đẹp của bản Tả Van và ruộng bậc thang Mường Hoa tại Lào Cai.`
    }
    if (hgTour) {
      res += `\n\n${hgTour.title} [TOUR:${hgTour.id}] - Hành trình ${hgTour.duration} chinh phục đèo Mã Pí Lèng hùng vĩ và đi thuyền trên dòng sông Nho Quế xanh ngọc bích tại Hà Giang.`
    }
    res += '\n\nHãy cho mình biết bạn quan tâm đến điểm đến nào hơn, hoặc nếu bạn cần thêm thông tin về các tour khác!'
    return res
  }

  if (q.includes('côn đảo') && (q.includes('kiên giang') || q.includes('phú quốc'))) {
    const conDaoTour = activeTours.find((t) => t.slug === 'con-dao-blue') || activeTours.find((t) => t.location.includes('Côn Đảo'))
    const phuQuocTour = activeTours.find((t) => t.slug === 'phu-quoc-blue') || activeTours.find((t) => t.location.includes('Phú Quốc'))
    let res = 'Côn Đảo là vùng đảo thiêng liêng và thanh bình thuộc tỉnh Bà Rịa - Vũng Tàu, chứ không phải Kiên Giang bạn nhé (Kiên Giang nổi tiếng với đảo ngọc Phú Quốc). Nếu bạn đang tìm kiếm kỳ nghỉ biển đảo, mình có thể gợi ý:'
    if (conDaoTour) {
      res += `\n\n${conDaoTour.title} [TOUR:${conDaoTour.id}] - Hành trình ${conDaoTour.duration} khám phá vẻ đẹp hoang sơ, bờ biển trong vắt và chiều sâu lịch sử linh thiêng tại Côn Đảo.`
    }
    if (phuQuocTour) {
      res += `\n\n${phuQuocTour.title} [TOUR:${phuQuocTour.id}] - Hành trình ${phuQuocTour.duration} tại Kiên Giang với hoàng hôn Sunset Sanato tuyệt đẹp và bãi biển cát trắng mịn.`
    }
    res += '\n\nHãy cho mình biết bạn quan tâm đến điểm đến nào hơn, hoặc nếu bạn cần thêm thông tin về các tour khác!'
    return res
  }

  const isAskingPrice = /(?:giá|bao nhiêu tiền|hết bao nhiêu|chi phí|mấy tiền|giá vé|vé bao nhiêu)/i.test(q)
  const isAskingDetails = /(?:chi tiết|mô tả|có gì|có những gì|tham quan|danh lam|thắng cảnh|địa điểm nào|sự kiện|chơi gì|trải nghiệm)/i.test(q)

  // Phát hiện thời lượng nếu khách yêu cầu
  let targetDuration = ''
  if (/3\s*ngày\s*2\s*đêm|3n2đ|3n2d/i.test(q)) targetDuration = '3 ngày 2 đêm'
  else if (/2\s*ngày\s*1\s*đêm|2n1đ|2n1d/i.test(q)) targetDuration = '2 ngày 1 đêm'
  else if (/1\s*ngày|trong ngày|ngay trong ngay/i.test(q)) targetDuration = '1 ngày'
  else if (/5\s*ngày\s*4\s*đêm|5n4đ|5n4d/i.test(q)) targetDuration = '5 ngày 4 đêm'

  // 3. Nhận diện các địa điểm CHƯA CÓ TRÊN WEB để gợi ý vùng lân cận tự nhiên
  type NeighborMapping = {
    keywords: string[]
    name: string
    suggestedQuery: (t: Tour) => boolean
    suggestedLocNames: string
  }

  const neighborMappings: NeighborMapping[] = [
    {
      keywords: ['thái nguyên', 'thai nguyen', 'tuyên quang', 'tuyen quang', 'lạng sơn', 'lang son', 'bắc giang', 'bac giang', 'phú thọ', 'phu tho', 'vĩnh phúc', 'vinh phuc', 'hải dương', 'hai duong', 'hưng yên', 'hung yen', 'thái bình', 'thai binh', 'nam định', 'nam dinh', 'hà nam', 'ha nam'],
      name: 'Thái Nguyên',
      suggestedQuery: (t) => ['Bắc Kạn', 'Cao Bằng', 'Hà Giang', 'Ninh Bình', 'Lào Cai'].includes(t.location),
      suggestedLocNames: 'Bắc Kạn, Hà Giang hoặc Sa Pa'
    },
    {
      keywords: ['nghệ an', 'nghe an', 'hà tĩnh', 'ha tinh', 'quảng trị', 'quang tri'],
      name: 'Nghệ An / Hà Tĩnh',
      suggestedQuery: (t) => ['Quảng Bình', 'Huế', 'Đà Nẵng'].some((l) => t.location.includes(l)),
      suggestedLocNames: 'Quảng Bình, Huế hoặc Đà Nẵng'
    },
    {
      keywords: ['đắk nông', 'dak nong', 'đắc nông', 'tà đùng', 'ta dung'],
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
      name: 'quốc tế',
      suggestedQuery: (t) => ['Kiên Giang', 'Quảng Ninh', 'Khánh Hòa', 'Đà Nẵng'].includes(t.location),
      suggestedLocNames: 'Phú Quốc, Vịnh Hạ Long, Nha Trang hoặc Đà Nẵng'
    }
  ]

  const matchedNeighbor = neighborMappings.find((m) => m.keywords.some((k) => q.includes(k)))
  if (matchedNeighbor) {
    const rawPlace = matchedNeighbor.keywords.find((k) => q.includes(k)) || matchedNeighbor.name
    const placeWord = rawPlace.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
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
    const t1 = picks[0]
    const t2 = picks[1]

    let body = `Hiện tại Đi Đâu chưa có tour du lịch tại ${placeWord}, chúng tôi sẽ sớm bổ sung thông tin về địa điểm du lịch này nhé!\n\nTuy nhiên, nếu bạn đang tìm kiếm một chuyến đi khám phá các điểm đến gần đó, mình có thể gợi ý cho bạn:`
    if (t1) {
      body += `\n\n${t1.title} [TOUR:${t1.id}] - Đây là một hành trình ${t1.duration} để bạn khám phá ${t1.location}, với những trải nghiệm nổi bật như ${t1.highlights}. ${t1.summary} Tour có giá niêm yết là ${formatVND(t1.price)}/khách.`
    }
    if (t2) {
      body += `\n\nHoặc nếu bạn muốn khám phá thêm một điểm đến khác gần đó:\n\n${t2.title} [TOUR:${t2.id}] - Một hành trình ${t2.duration} đưa bạn đến với ${t2.highlights}. ${t2.summary} (Giá: ${formatVND(t2.price)}/khách).`
    }
    body += '\n\nHãy cho mình biết bạn quan tâm đến điểm đến nào hơn, hoặc nếu bạn cần thêm thông tin về các tour khác!'
    return body
  }

  // 4. Tính điểm khớp tour chính xác
  const scoredTours = activeTours.map((t) => {
    let score = 0
    const loc = t.location.toLowerCase()
    const title = t.title.toLowerCase()
    const hl = t.highlights.toLowerCase()

    if (q.includes(title)) score += 30
    if (t.slug === 'moc-chau-tea-hills' && q.includes('mộc châu')) score += 40
    if (t.slug === 'ha-giang-loop' && q.includes('hà giang')) score += 40
    if (t.slug === 'mu-cang-chai-harvest' && q.includes('mù cang chải')) score += 40
    if (t.slug === 'sapa-cloud-hunting' && (q.includes('sa pa') || q.includes('sapa'))) score += 40
    if (t.slug === 'ninh-binh-river' && (q.includes('tràng an') || q.includes('ninh bình'))) score += 40
    if (t.slug === 'hoi-an-slow-days' && q.includes('hội an')) score += 40
    if (t.slug === 'da-nang-son-tra' && (q.includes('đà nẵng') || q.includes('sơn trà'))) score += 40
    if (t.slug === 'phong-nha-cave-expedition' && (q.includes('phong nha') || q.includes('quảng bình'))) score += 40
    if (t.slug === 'phu-quoc-blue' && q.includes('phú quốc')) score += 40
    if (t.slug === 'con-dao-blue' && q.includes('côn đảo')) score += 40
    if (t.slug === 'dalat-pine-escape' && q.includes('đà lạt')) score += 40
    if (t.slug === 'mang-den-pine-mist' && q.includes('măng đen')) score += 40
    if (t.slug === 'buon-ma-thuot-coffee' && (q.includes('buôn ma thuột') || q.includes('đắk lắk'))) score += 40
    if (title.includes('mộc châu') && q.includes('mộc châu')) score += 20
    if (title.includes('tràng an') && q.includes('tràng an')) score += 18
    if (title.includes('cúc phương') && q.includes('cúc phương')) score += 18
    if (title.includes('sơn trà') && (q.includes('sơn trà') || q.includes('linh ứng') || q.includes('bàn cờ'))) score += 18
    if (title.includes('hội an') && q.includes('hội an')) score += 18
    if (title.includes('mỹ sơn') && q.includes('mỹ sơn')) score += 18
    if (title.includes('bà nà') && (q.includes('bà nà') || q.includes('cầu vàng'))) score += 18
    if (title.includes('phong nha') && q.includes('phong nha')) score += 18
    if (title.includes('hang én') && q.includes('hang én')) score += 18
    if (title.includes('hạ long') && q.includes('hạ long')) score += 18
    if (title.includes('bình liêu') && q.includes('bình liêu')) score += 18
    if (title.includes('hà giang') && q.includes('hà giang')) score += 18
    if (title.includes('quản bạ') && q.includes('quản bạ')) score += 18
    if (title.includes('mù cang chải') && q.includes('mù cang chải')) score += 18
    if (title.includes('măng đen') && q.includes('măng đen')) score += 18
    if (title.includes('buôn ma thuột') && (q.includes('buôn ma thuột') || q.includes('hồ lắk'))) score += 18
    if (title.includes('biển hồ') && (q.includes('biển hồ') || q.includes('chư đăng ya') || q.includes('pleiku'))) score += 18
    if (title.includes('vĩnh hy') && (q.includes('vĩnh hy') || q.includes('hang rái'))) score += 18
    if (title.includes('mũi né') && (q.includes('mũi né') || q.includes('phan thiết'))) score += 18
    if (title.includes('nam du') && q.includes('nam du')) score += 18
    if (title.includes('phú quốc') && q.includes('phú quốc')) score += 18
    if (title.includes('côn đảo') && q.includes('côn đảo')) score += 18
    if (title.includes('vũng tàu') && q.includes('vũng tàu')) score += 18
    if (title.includes('đà lạt') && (q.includes('đà lạt') || q.includes('tuyền lâm'))) score += 18
    if (title.includes('tây ninh') && (q.includes('tây ninh') || q.includes('bà đen'))) score += 18
    if (title.includes('bến tre') && q.includes('bến tre')) score += 18
    if (title.includes('đồng tháp') && (q.includes('đồng tháp') || q.includes('tràm chim') || q.includes('tháp mười'))) score += 18
    if (title.includes('cà mau') && (q.includes('cà mau') || q.includes('đất mũi'))) score += 18
    if (title.includes('an giang') && (q.includes('trà sư') || q.includes('châu đốc'))) score += 18
    if (title.includes('cần thơ') && (q.includes('cần thơ') || q.includes('cái răng'))) score += 18
    if (title.includes('lan hạ') && (q.includes('lan hạ') || q.includes('cát bà'))) score += 18
    if (title.includes('ba bể') && (q.includes('ba bể') || q.includes('bắc kạn'))) score += 18
    if (title.includes('tả van') && (q.includes('sa pa') || q.includes('sapa') || q.includes('tả van'))) score += 18

    if (q.includes(loc)) score += 6
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
    if (loc.includes('sơn la') && q.includes('mộc châu')) score += 10

    if (q.includes('đèn lồng') && hl.includes('đèn lồng')) score += 6
    if (q.includes('săn mây') && (hl.includes('săn mây') || title.includes('săn mây'))) score += 6
    if (q.includes('lặn') && (hl.includes('lặn') || title.includes('lặn'))) score += 6

    return { tour: t, score }
  })

  scoredTours.sort((a, b) => b.score - a.score)
  const bestMatch = scoredTours[0]?.score > 0 ? scoredTours[0].tour : null

  if (bestMatch) {
    if (isAskingPrice && !isAskingDetails) {
      return `Tour ${bestMatch.title} [TOUR:${bestMatch.id}] hiện có giá niêm yết chính xác là ${formatVND(bestMatch.price)}/khách cho hành trình ${bestMatch.duration}.\n\nMức giá này đã bao gồm trọn gói: ${bestMatch.included}. Trong suốt chuyến đi, bạn sẽ được ghé thăm ${bestMatch.highlights}.\n\nHãy cho mình biết nếu bạn cần thêm thông tin chi tiết hoặc muốn mình tư vấn thêm về ngày khởi hành nhé!`
    }
    return `${bestMatch.title} [TOUR:${bestMatch.id}] - Đây là một hành trình ${bestMatch.duration} tuyệt vời để bạn khám phá vẻ đẹp của ${bestMatch.location}.\n\nTrong chuyến đi này, bạn sẽ được trải nghiệm ${bestMatch.highlights}. ${bestMatch.summary}\n\nTour hiện có giá niêm yết là ${formatVND(bestMatch.price)}/khách, đã bao gồm trọn gói: ${bestMatch.included}.\n\nHãy cho mình biết nếu bạn quan tâm đến hành trình này hoặc cần tìm hiểu thêm các tour khác nhé!`
  }

  // 5. Nếu hỏi theo thời lượng
  if (targetDuration) {
    let durMatches = activeTours.filter((t) => t.duration.toLowerCase().includes(targetDuration.toLowerCase()))
    if (budget) {
      const withBud = durMatches.filter((t) => t.price <= budget)
      if (withBud.length > 0) durMatches = withBud
    }
    const picks = durMatches.slice(0, 2)
    if (picks.length > 0) {
      let body = `Nếu bạn đang tìm kiếm các hành trình đúng ${targetDuration}${budget ? ' trong ngân sách ' + formatVND(budget) : ''}, mình có thể gợi ý cho bạn:`
      for (const t of picks) {
        body += `\n\n${t.title} [TOUR:${t.id}] - Hành trình ${t.duration} khám phá ${t.location} với những điểm nhấn nổi bật: ${t.highlights}. ${t.summary} (Giá: ${formatVND(t.price)}/khách).`
      }
      body += '\n\nHãy cho mình biết bạn quan tâm đến điểm đến nào hơn, hoặc nếu bạn cần thêm thông tin về các tour khác!'
      return body
    }
  }

  // 6. Nếu hỏi theo ngân sách hoặc thể loại
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
      let body = 'Hiện tại Đi Đâu chưa có tour du lịch tại địa điểm này, chúng tôi sẽ sớm bổ sung thông tin về địa điểm du lịch này nhé!\n\nTuy nhiên, bạn có thể tham khảo một số hành trình hấp dẫn với trải nghiệm đặc sắc đang có sẵn trên website:'
      for (const t of picks) {
        body += `\n\n${t.title} [TOUR:${t.id}] - Hành trình ${t.duration} khám phá ${t.location} (${t.highlights}). Giá: ${formatVND(t.price)}/khách.`
      }
      body += '\n\nHãy cho mình biết nếu bạn cần thêm thông tin về các tour này nhé!'
      return body
    }
  }

  const selected = candidates.slice(0, 2)
  if (selected.length === 0) {
    return 'Hiện tại chưa có tour du lịch phù hợp với yêu cầu này, Đi Đâu sẽ sớm bổ sung thêm nhé! Bạn hãy cho mình biết sở thích hoặc khoảng thời gian bạn muốn đi để mình tư vấn các hành trình phù hợp nhất nhé!'
  }

  let body = budget
    ? `Với mức ngân sách tầm ${formatVND(budget)}, mình có thể gợi ý cho bạn hành trình lý tưởng sau:`
    : 'Nếu bạn đang lên kế hoạch cho chuyến đi sắp tới, mình có thể gợi ý cho bạn hành trình tuyệt vời sau:'

  for (const t of selected) {
    body += `\n\n${t.title} [TOUR:${t.id}] - Hành trình ${t.duration} tại ${t.location} (${t.highlights}). ${t.summary} Giá niêm yết: ${formatVND(t.price)}/khách.`
  }
  body += '\n\nHãy cho mình biết bạn quan tâm đến điểm đến nào hơn, hoặc nếu bạn cần thêm thông tin về các tour khác!'
  return body
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

  const systemPrompt = `Bạn là Trợ lý Cố vấn Hành trình của nền tảng du lịch "Đi Đâu" (didau.vn).
Phương châm: "Đi chậm hơn. Nhớ lâu hơn."

DANH SÁCH TOÀN BỘ CÁC TOUR DU LỊCH ĐANG CÓ THẬT TRÊN WEBSITE ĐI ĐÂU:
${toursSummary}

QUY TẮC BẮT BUỘC VỀ VĂN PHONG VÀ CÁCH TRẢ LỜI (MÔ PHỎNG CHÍNH XÁC PHONG CÁCH TỰ NHIÊN, KHÔNG MÁY MÓC):

1. PHONG CÁCH TỰ NHIÊN, THÂN THIỆN NHƯ NGƯỜI BẢN ĐỊA THẬT:
- Xưng hô "mình" và "bạn". Giọng điệu ấm áp, tự nhiên, nhã nhặn, am hiểu sâu sắc về địa lý và văn hóa du lịch Việt Nam.
- TUYỆT ĐỐI KHÔNG DÙNG CÁC NHÃN HAY ICON MÁY MÓC (Không dùng các gạch đầu dòng kiểu "🌿 Cảm hứng hành trình:", "📍 Các danh lam thắng cảnh:", "✨ Dịch vụ chăm sóc:", "💡 Lời khuyên du lịch:").
- Hãy viết thành các đoạn văn xuôi trôi chảy, có sự liên kết tự nhiên giữa các câu, mượt mà và logic.

2. PHÂN TÍCH THÔNG MINH & ĐÍNH CHÍNH ĐỊA LÝ NHẸ NHÀNG:
- Hãy phân tích thật kỹ câu hỏi của khách:
  * Nếu khách có sự nhầm lẫn về địa lý (ví dụ: "Tôi muốn đi Mộc Châu, Mộc Châu ở Hà Giang"), hãy khen điểm đến và đính chính nhẹ nhàng, lịch sự:
    "Mộc Châu là một điểm đến tuyệt vời! Tuy nhiên, Mộc Châu lại thuộc tỉnh Sơn La, chứ không phải Hà Giang. Nếu bạn đang tìm kiếm một chuyến đi đến Mộc Châu, mình có thể gợi ý cho bạn:"
  * Sau đó giới thiệu tour cụ thể:
    "[Tên tour] [TOUR:id] – Đây là một hành trình [thời lượng] để bạn khám phá vẻ đẹp của [địa danh], với [các điểm tham quan, danh thắng, trải nghiệm bản địa từ dữ liệu highlights và summary]."
  * Có thể chủ động gợi ý thêm điểm đến lân cận tương tự nếu phù hợp:
    "Hoặc nếu bạn muốn khám phá thêm các điểm đến khác gần [địa danh], mình cũng có thể gợi ý:
    [Tên tour lân cận] [TOUR:id] – [Đoạn văn ngắn mô tả vẻ đẹp và thời lượng]."
  * Kết thúc thân thiện:
    "Hãy cho mình biết bạn quan tâm đến điểm đến nào hơn, hoặc nếu bạn cần thêm thông tin về các tour khác!"

3. KHI ĐỊA ĐIỂM KHÁCH HỎI CÓ TRÊN WEB:
- Mô tả sâu sắc, chân thực các điểm tham quan, hoạt động, danh lam thắng cảnh trong tour dựa trên highlights, summary.
- Nếu khách hỏi giá: Báo đúng giá niêm yết chuẩn xác trong dữ liệu (VNĐ/khách) và nói rõ mức giá này đã bao gồm trọn gói những gì (included).
- TUYỆT ĐỐI KHÔNG BỊA ĐẶT những địa điểm, sự kiện hay giá tiền không có trong dữ liệu tour.

4. KHI ĐỊA ĐIỂM KHÁCH HỎI CHƯA CÓ TRÊN WEB (ví dụ: Thái Nguyên, Lạng Sơn, Tuyên Quang, Phú Thọ, Nghệ An, Đắk Nông, Tiền Giang, hoặc tour nước ngoài...):
- Bắt buộc trả lời trung thực:
  "Hiện tại Đi Đâu chưa có tour du lịch tại [Tên địa điểm] này, chúng tôi sẽ sớm bổ sung thông tin về địa điểm du lịch này nhé!
  Tuy nhiên, nếu bạn đang tìm kiếm một chuyến đi khám phá cảnh sắc [núi rừng / biển đảo / sông nước] tương tự ở gần đó, mình có thể gợi ý cho bạn:
  [Tên tour lân cận] [TOUR:id] – [Đoạn văn ngắn mô tả vẻ đẹp, thời lượng, giá tiền từ dữ liệu thật].
  Hoặc nếu bạn muốn tham khảo thêm:
  [Tên tour 2] [TOUR:id] – [Đoạn văn mô tả].
  Hãy cho mình biết bạn quan tâm đến hành trình nào hơn nhé!"

5. ĐỊNH DẠNG:
- BẮT BUỘC gắn mã [TOUR:id] ngay sau tên mỗi tour được nhắc đến để hệ thống hiển thị thẻ tour cho khách xem và đặt.
- Trả lời bằng tiếng Việt tự nhiên, ngắt đoạn thoáng mắt, văn phong lịch thiệp, tạo cảm giác gần gũi, tin cậy.`

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
