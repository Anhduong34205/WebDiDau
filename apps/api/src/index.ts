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
  let q = query.toLowerCase()
    .replace(/(\d+)\s*(?:tr|triệu)\s*(\d+)/gi, '$1.$2 triệu')
    .replace(/(\d+)\s*củ\s*(\d+)/gi, '$1.$2 triệu')
    .replace(/(\d+)\s*củ/gi, '$1 triệu')

  const match = q.match(/(?:dưới|tầm|khoảng|ngân sách|tối đa|dưới mức|chừng|có|chỉ có|tài chính|tầm giá|mức|tầm khoảng|còn|với|tầm)\s*([\d,.]+)\s*(triệu|tr|k|nghìn|đ|vnd|đồng)?/i) ||
                q.match(/([\d,.]+)\s*(triệu|tr|k|nghìn|đ|vnd|đồng)?\s*(?:đổ lại|trở xuống|quay đầu|trở lại|thôi)/i)

  if (match) {
    const num = parseFloat(match[1].replace(',', '.'))
    if (!Number.isFinite(num)) return null
    const unit = match[2]?.toLowerCase()
    if (unit === 'triệu' || unit === 'tr') return Math.round(num * 1_000_000)
    if (unit === 'k' || unit === 'nghìn') return Math.round(num * 1_000)
    if (num < 50) return Math.round(num * 1_000_000)
    return Math.round(num)
  }
  return null
}

const formatVND = (price: number) =>
  new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(price)

const generateSmartFallbackReply = (query: string, tours: Tour[], forcedBudget?: number | null): string => {
  const q = query.toLowerCase()
  const budget = forcedBudget !== undefined ? forcedBudget : parseBudgetFromQuery(q)

  // 1. Kiểm tra câu hỏi ngoài phạm vi tour/du lịch
  const nonTravelTopics = [
    'lập trình', 'code', 'python', 'javascript', 'html', 'css', 'toán', 'vật lý', 'hóa học',
    'chính trị', 'tin tức', 'thời sự', 'chứng khoán', 'crypto', 'bitcoin', 'thời tiết hôm nay',
    'dịch thuật', 'bóng đá', 'nấu ăn'
  ]
  if (nonTravelTopics.some((topic) => q.includes(topic))) {
    return 'Dạ Đi Đâu AI được thiết kế chuyên biệt để đồng hành và tư vấn các hành trình du lịch bản địa sâu sắc trên website Đi Đâu thôi ạ. Rất mong bạn thông cảm nhé!\n\nNếu bạn đang ấp ủ một chuyến du ngoạn lên vùng cao săn mây ngắm lúa, về miền biển xanh cát trắng hay tìm về những miền di sản văn hóa an yên, bạn cứ chia sẻ cùng mình để chúng mình cùng lên kế hoạch nhé!'
  }

  // Lọc các tour đang hoạt động. NẾU CÓ NGÂN SÁCH: BẮT BUỘC price <= budget (Luật cứng 5)
  let activeTours = tours.filter((t) => t.active === 1)
  if (budget !== null && budget > 0) {
    activeTours = activeTours.filter((t) => t.price <= budget)
    if (activeTours.length === 0) {
      return `Với mức ngân sách tối đa ${formatVND(budget)}/khách, hiện tại Đi Đâu chưa có hành trình nào phù hợp trong danh sách tour đang khai thác bạn nhé. Bạn có thể cân nhắc nâng ngân sách hoặc chia sẻ thêm nhu cầu để mình hỗ trợ tốt nhất!`
    }
  }

  // 2. Nhận diện và đính chính nhầm lẫn địa lý (Luật cứng 15: nhẹ nhàng, không bịa kiến thức ngoài)
  if (q.includes('mộc châu') && (q.includes('hà giang') || q.includes('ở đâu') || q.includes('thuộc tỉnh'))) {
    const mocChauTour = activeTours.find((t) => t.slug === 'moc-chau-tea-hills') || activeTours.find((t) => t.title.toLowerCase().includes('mộc châu'))
    const hgTour = activeTours.find((t) => t.slug === 'ha-giang-loop') || activeTours.find((t) => t.title.toLowerCase().includes('hà giang'))
    let res = 'Mộc Châu thì đúng là một lựa chọn rất đẹp bạn ạ, chỉ có một chi tiết nhỏ mình đính chính để bạn khỏi nhầm: Mộc Châu thuộc Sơn La chứ không thuộc Hà Giang nhé.'
    if (mocChauTour) {
      res += `\n\nTrong danh sách của Đi Đâu, bạn có thể tham khảo chuyến ${mocChauTour.title} [TOUR:${mocChauTour.id}]. Đây là hành trình ${mocChauTour.duration} với mức giá niêm yết ${formatVND(mocChauTour.price)}/khách. Điểm nổi bật gồm có: ${mocChauTour.highlights}. ${mocChauTour.summary}`
    }
    if (hgTour) {
      res += `\n\nCòn nếu bạn muốn trải nghiệm vùng núi Hà Giang, Đi Đâu có chuyến ${hgTour.title} [TOUR:${hgTour.id}] (${hgTour.duration}, giá ${formatVND(hgTour.price)}/khách) với các trải nghiệm: ${hgTour.highlights}.`
    }
    return res
  }

  if ((q.includes('sa pa') || q.includes('sapa')) && q.includes('hà giang')) {
    const sapaTour = activeTours.find((t) => t.slug === 'sapa-cloud-hunting') || activeTours.find((t) => t.location.includes('Lào Cai'))
    const hgTour = activeTours.find((t) => t.slug === 'ha-giang-loop') || activeTours.find((t) => t.location.includes('Hà Giang'))
    let res = 'Sa Pa thuộc tỉnh Lào Cai chứ không nằm ở Hà Giang bạn nhé.'
    if (sapaTour) {
      res += `\n\nTại Lào Cai, Đi Đâu có hành trình ${sapaTour.title} [TOUR:${sapaTour.id}] (${sapaTour.duration}, giá niêm yết ${formatVND(sapaTour.price)}/khách), nổi bật với: ${sapaTour.highlights}.`
    }
    if (hgTour) {
      res += `\n\nCòn nếu bạn quan tâm đến Hà Giang, Đi Đâu có chuyến ${hgTour.title} [TOUR:${hgTour.id}] (${hgTour.duration}, giá ${formatVND(hgTour.price)}/khách), trải nghiệm: ${hgTour.highlights}.`
    }
    return res
  }

  if (q.includes('côn đảo') && (q.includes('kiên giang') || q.includes('phú quốc'))) {
    const conDaoTour = activeTours.find((t) => t.slug === 'con-dao-blue') || activeTours.find((t) => t.location.includes('Côn Đảo'))
    const phuQuocTour = activeTours.find((t) => t.slug === 'phu-quoc-blue') || activeTours.find((t) => t.location.includes('Phú Quốc'))
    let res = 'Côn Đảo thuộc tỉnh Bà Rịa - Vũng Tàu chứ không thuộc Kiên Giang bạn nha (Kiên Giang có đảo ngọc Phú Quốc).'
    if (conDaoTour) {
      res += `\n\nNếu bạn muốn đến Côn Đảo, Đi Đâu có chuyến ${conDaoTour.title} [TOUR:${conDaoTour.id}] (${conDaoTour.duration}, giá ${formatVND(conDaoTour.price)}/khách), điểm nổi bật: ${conDaoTour.highlights}.`
    }
    if (phuQuocTour) {
      res += `\n\nCòn tại Phú Quốc (Kiên Giang), bạn có thể xem chuyến ${phuQuocTour.title} [TOUR:${phuQuocTour.id}] (${phuQuocTour.duration}, giá ${formatVND(phuQuocTour.price)}/khách).`
    }
    return res
  }

  if (q.includes('tràng an') && (q.includes('quảng ninh') || q.includes('hạ long'))) {
    const ninhBinhTour = activeTours.find((t) => t.slug === 'ninh-binh-river') || activeTours.find((t) => t.location.includes('Ninh Bình'))
    let res = 'Danh thắng Tràng An thuộc tỉnh Ninh Bình chứ không phải Quảng Ninh bạn nhé.'
    if (ninhBinhTour) {
      res += `\n\nĐi Đâu có chuyến ${ninhBinhTour.title} [TOUR:${ninhBinhTour.id}] (${ninhBinhTour.duration}, giá ${formatVND(ninhBinhTour.price)}/khách), nổi bật với: ${ninhBinhTour.highlights}. ${ninhBinhTour.summary}`
    }
    return res
  }

  // 3. Địa điểm KHÔNG CÓ TRONG DATA (Luật cứng 2 & 3: KHÔNG bịa đặc sản/danh lam bên ngoài, chỉ gợi ý tour có trong data)
  const nonDataPlaces: { [key: string]: string } = {
    'thái nguyên': 'Thái Nguyên',
    'lạng sơn': 'Lạng Sơn',
    'tuyên quang': 'Tuyên Quang',
    'bắc giang': 'Bắc Giang',
    'phú thọ': 'Phú Thọ',
    'vĩnh phúc': 'Vĩnh Phúc',
    'hải dương': 'Hải Dương',
    'hưng yên': 'Hưng Yên',
    'thái bình': 'Thái Bình',
    'nam định': 'Nam Định',
    'hà nam': 'Hà Nam',
    'nghệ an': 'Nghệ An',
    'hà tĩnh': 'Hà Tĩnh',
    'quảng trị': 'Quảng Trị',
    'đắk nông': 'Đắk Nông',
    'tà đùng': 'Tà Đùng',
    'tiền giang': 'Tiền Giang',
    'vĩnh long': 'Vĩnh Long',
    'trà vinh': 'Trà Vinh',
    'hậu giang': 'Hậu Giang',
    'sóc trăng': 'Sóc Trăng',
    'bạc liêu': 'Bạc Liêu',
    'long an': 'Long An',
    'bình phước': 'Bình Phước',
    'thái lan': 'Thái Lan',
    'singapore': 'Singapore',
    'hàn quốc': 'Hàn Quốc',
    'nhật bản': 'Nhật Bản',
  }

  const getRegionalCandidates = (queryStr: string, tourList: Tour[]): Tour[] => {
    const northKeys = ['thái nguyên', 'lạng sơn', 'tuyên quang', 'bắc giang', 'phú thọ', 'vĩnh phúc', 'hải dương', 'hưng yên', 'thái bình', 'nam định', 'hà nam']
    const centralKeys = ['nghệ an', 'hà tĩnh', 'quảng trị']
    const southKeys = ['tiền giang', 'vĩnh long', 'trà vinh', 'hậu giang', 'sóc trăng', 'bạc liêu', 'long an', 'bình phước']
    const highKeys = ['đắk nông', 'tà đùng']

    if (northKeys.some((k) => queryStr.includes(k))) {
      const north = tourList.filter((t) => ['hà giang', 'sơn la', 'lào cai', 'yên bái', 'ninh bình', 'quảng ninh', 'bắc kạn', 'cao bằng'].some((loc) => t.location.toLowerCase().includes(loc)))
      if (north.length > 0) return north
    }
    if (centralKeys.some((k) => queryStr.includes(k))) {
      const central = tourList.filter((t) => ['quảng bình', 'huế', 'đà nẵng', 'quảng nam', 'bình định', 'khánh hòa'].some((loc) => t.location.toLowerCase().includes(loc)))
      if (central.length > 0) return central
    }
    if (southKeys.some((k) => queryStr.includes(k))) {
      const south = tourList.filter((t) => ['cần thơ', 'an giang', 'đồng tháp', 'kiên giang', 'bà rịa', 'bến tre'].some((loc) => t.location.toLowerCase().includes(loc)))
      if (south.length > 0) return south
    }
    if (highKeys.some((k) => queryStr.includes(k))) {
      const highlands = tourList.filter((t) => ['đắk lắk', 'gia lai', 'kon tum', 'lâm đồng'].some((loc) => t.location.toLowerCase().includes(loc)))
      if (highlands.length > 0) return highlands
    }
    return tourList
  }

  for (const [key, placeName] of Object.entries(nonDataPlaces)) {
    if (q.includes(key)) {
      const regionalPool = getRegionalCandidates(q, activeTours)
      const picks = regionalPool.slice(0, 2)
      if (picks.length === 0) {
        return `Hiện tại Đi Đâu chưa có hành trình tại ${placeName} trong danh sách tour đang khai thác bạn nhé.`
      }
      let reply = `Hiện tại Đi Đâu chưa có hành trình tại ${placeName} trong danh sách tour đang khai thác bạn nhé.\n\nNếu bạn đang tìm một hành trình có trải nghiệm phù hợp${budget ? ' với ngân sách ' + formatVND(budget) : ''}, mình gợi ý bạn tham khảo chuyến ${picks[0].title} [TOUR:${picks[0].id}] tại ${picks[0].location}. Đây là hành trình ${picks[0].duration} với giá niêm yết ${formatVND(picks[0].price)}/khách, điểm nổi bật: ${picks[0].highlights}. ${picks[0].summary}`
      if (picks[1]) {
        reply += `\n\nNgoài ra, bạn cũng có thể cân nhắc thêm chuyến ${picks[1].title} [TOUR:${picks[1].id}] (${picks[1].duration}, giá ${formatVND(picks[1].price)}/khách) tại ${picks[1].location}.`
      }
      return reply
    }
  }

  // 4. Tìm kiếm theo tour cụ thể trong data
  const scoredTours = activeTours.map((t) => {
    let score = 0
    const loc = t.location.toLowerCase()
    const title = t.title.toLowerCase()
    const hl = t.highlights.toLowerCase()

    if (q.includes(title)) score += 30
    if (title.includes('mộc châu') && q.includes('mộc châu')) score += 20
    if (title.includes('tràng an') && q.includes('tràng an')) score += 18
    if (title.includes('hà giang') && q.includes('hà giang')) score += 18
    if (title.includes('mù cang chải') && q.includes('mù cang chải')) score += 18
    if (title.includes('hội an') && q.includes('hội an')) score += 18
    if (title.includes('đà nẵng') && q.includes('đà nẵng')) score += 18
    if (title.includes('phong nha') && q.includes('phong nha')) score += 18
    if (title.includes('hạ long') && q.includes('hạ long')) score += 18
    if (title.includes('đà lạt') && q.includes('đà lạt')) score += 18
    if (title.includes('phú quốc') && q.includes('phú quốc')) score += 18
    if (title.includes('côn đảo') && q.includes('côn đảo')) score += 18
    if (title.includes('măng đen') && q.includes('măng đen')) score += 18
    if (title.includes('buôn ma thuột') && (q.includes('buôn ma thuột') || q.includes('đắk lắk'))) score += 18
    if (title.includes('cần thơ') && q.includes('cần thơ')) score += 18
    if (title.includes('ba bể') && (q.includes('ba bể') || q.includes('bắc kạn'))) score += 18
    if (title.includes('tả van') && (q.includes('tả van') || q.includes('sa pa') || q.includes('sapa'))) score += 18

    if (q.includes(loc)) score += 6
    if (loc.includes('lâm đồng') && q.includes('đà lạt')) score += 8
    if (loc.includes('lào cai') && (q.includes('sa pa') || q.includes('sapa'))) score += 8
    if (loc.includes('quảng ninh') && q.includes('hạ long')) score += 8
    if (loc.includes('kiên giang') && q.includes('phú quốc')) score += 8
    if (loc.includes('bà rịa') && (q.includes('côn đảo') || q.includes('vũng tàu'))) score += 8
    if (loc.includes('quảng nam') && q.includes('hội an')) score += 8
    if (loc.includes('sơn la') && q.includes('mộc châu')) score += 10

    if (q.includes('săn mây') && (hl.includes('săn mây') || title.includes('săn mây'))) score += 6
    if (q.includes('biển') && (t.category === 'Biển đảo' || hl.includes('biển'))) score += 6

    return { tour: t, score }
  })

  scoredTours.sort((a, b) => b.score - a.score)
  const bestMatch = scoredTours[0]?.score > 0 ? scoredTours[0].tour : null

  const isAskingPrice = /(?:giá|bao nhiêu tiền|hết bao nhiêu|chi phí|mấy tiền|giá vé|vé bao nhiêu)/i.test(q)
  const isAskingDetails = /(?:chi tiết|mô tả|có gì|có những gì|tham quan|danh lam|thắng cảnh|địa điểm nào|sự kiện|chơi gì|trải nghiệm)/i.test(q)

  if (bestMatch) {
    if (isAskingPrice && !isAskingDetails) {
      return `Dạ chuyến ${bestMatch.title} [TOUR:${bestMatch.id}] hiện có giá niêm yết chính xác là ${formatVND(bestMatch.price)}/khách cho hành trình ${bestMatch.duration} bạn nhé.\n\nTrong mức giá này, các dịch vụ bao gồm gồm có: ${bestMatch.included}. Điểm nổi bật của hành trình: ${bestMatch.highlights}. ${bestMatch.summary}`
    }
    return `Về chuyến ${bestMatch.title} [TOUR:${bestMatch.id}] tại ${bestMatch.location}:\n\nĐây là hành trình ${bestMatch.duration} với mức giá niêm yết chính xác là ${formatVND(bestMatch.price)}/khách (bao gồm: ${bestMatch.included}).\n\nCác điểm nổi bật trong hành trình gồm có: ${bestMatch.highlights}. ${bestMatch.summary}\n\nBạn cần thêm thông tin gì về chuyến đi này cứ cho mình biết nhé!`
  }

  // 5. Nếu hỏi theo ngân sách ("có 4 triệu đi đâu", "ngân sách 3tr"...)
  let candidates = [...activeTours]
  if (q.includes('biển') || q.includes('đảo') || q.includes('lặn')) {
    const bySea = candidates.filter((t) => t.category === 'Biển đảo' || t.title.toLowerCase().includes('biển'))
    if (bySea.length > 0) candidates = bySea
  } else if (q.includes('săn mây') || q.includes('leo núi') || q.includes('trekking') || q.includes('núi') || q.includes('phiêu lưu')) {
    const byAdv = candidates.filter((t) => t.category === 'Phiêu lưu' || t.summary.toLowerCase().includes('mây'))
    if (byAdv.length > 0) candidates = byAdv
  } else if (q.includes('văn hóa') || q.includes('lịch sử') || q.includes('phố cổ') || q.includes('ẩm thực')) {
    const byCulture = candidates.filter((t) => t.category === 'Văn hóa')
    if (byCulture.length > 0) candidates = byCulture
  }

  const picks = candidates.slice(0, 3)
  if (picks.length === 0) {
    return `Hiện tại Đi Đâu chưa có hành trình phù hợp với tiêu chí này trong danh sách tour đang khai thác bạn nhé.`
  }

  if (budget) {
    let reply = `Với mức ngân sách khoảng ${formatVND(budget)}/khách, Đi Đâu có một số hành trình phù hợp trong tầm giá để bạn tham khảo:\n`
    picks.forEach((t) => {
      reply += `\n- ${t.title} [TOUR:${t.id}] tại ${t.location} (${t.duration}): Giá ${formatVND(t.price)}/khách. Điểm nổi bật: ${t.highlights}.`
    })
    reply += `\n\nBạn quan tâm đến hành trình nào hơn hoặc cần biết thêm thông tin cụ thể cứ nhắn mình nhé!`
    return reply
  }

  const t1 = picks[0]
  return `Nếu bạn đang tìm một chuyến đi trải nghiệm cảnh sắc thiên nhiên và văn hóa bản địa, mình gợi ý chuyến ${t1.title} [TOUR:${t1.id}] tại ${t1.location}. Hành trình ${t1.duration} này có giá niêm yết ${formatVND(t1.price)}/khách, nổi bật với: ${t1.highlights}. ${t1.summary}\n\nBạn cần tìm hiểu thêm thông tin về hành trình này cứ nhắn mình nhé!`
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

  const userMessages = sanitizedMessages.filter((m) => m.role === 'user')
  const latestUser = userMessages[userMessages.length - 1]
  const userQuery = latestUser ? latestUser.content : ''

  // LUẬT CỨNG SỐ 6: Nhớ ngân sách xuyên suốt cuộc hội thoại
  let extractedBudget = parseBudgetFromQuery(userQuery)
  if (extractedBudget === null) {
    for (let i = userMessages.length - 2; i >= 0; i--) {
      const prevBudget = parseBudgetFromQuery(userMessages[i].content)
      if (prevBudget !== null) {
        extractedBudget = prevBudget
        break
      }
    }
  }

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

  const systemPrompt = `# VAI TRÒ

Bạn là "Trợ lý Cố vấn Hành trình" của nền tảng du lịch Đi Đâu (didau.vn).

Bạn đang đóng vai một người bạn bản địa thân thiện, tinh tế và hiểu nhu cầu du lịch của khách.

Phương châm của Đi Đâu:
"Đi chậm hơn. Nhớ lâu hơn."

Tuy nhiên, có một nguyên tắc QUAN TRỌNG HƠN TẤT CẢ:

==================================================
NGUYÊN TẮC TỐI CAO: DATA-FIRST / CLOSED-WORLD
==================================================

Dữ liệu tour được cung cấp bên dưới là NGUỒN SỰ THẬT DUY NHẤT mà bạn được phép sử dụng để trả lời về:

- tour
- điểm đến
- địa danh
- lịch trình
- giá
- thời lượng
- trải nghiệm
- dịch vụ
- điểm tham quan
- đặc điểm hành trình
- địa lý liên quan đến tour
- sự phù hợp của tour

DANH SÁCH TOÀN BỘ TOUR THỰC TẾ ĐANG CÓ TRÊN WEBSITE ĐI ĐÂU:

${toursSummary}

==================================================
LUẬT CỨNG SỐ 1: KHÔNG ĐƯỢC BỊA DỮ LIỆU
==================================================

Bạn TUYỆT ĐỐI KHÔNG được tự tạo, tự suy luận hoặc lấy kiến thức bên ngoài để biến thành thông tin của Đi Đâu.

Nếu thông tin không xuất hiện hoặc không thể xác định rõ ràng từ dữ liệu được cung cấp, phải coi như:

"Đi Đâu CHƯA CÓ / CHƯA CUNG CẤP thông tin đó."

Không được đoán.

Không được "có vẻ như".

Không được dùng kiến thức chung của mô hình để điền vào chỗ trống.

Không được tự nhớ thông tin du lịch từ bên ngoài rồi đưa vào câu trả lời như thể đó là dữ liệu của Đi Đâu.

Câu nói quan trọng nhất cần ghi nhớ:

DATA CỦA ĐI ĐÂU > KIẾN THỨC BÊN NGOÀI > SUY ĐOÁN.

Nếu dữ liệu Đi Đâu không có, hãy nói không có.

==================================================
LUẬT CỨNG SỐ 2: KIỂM TRA ĐỊA ĐIỂM TRƯỚC KHI TRẢ LỜI
==================================================

Mỗi khi người dùng hỏi về một địa điểm, trước tiên phải xác định:

"Địa điểm này có thực sự xuất hiện trong dữ liệu Đi Đâu hay không?"

Có 2 trường hợp.

--------------------------------------------------
TRƯỜNG HỢP A — ĐỊA ĐIỂM CÓ TRONG DATA
--------------------------------------------------

Nếu địa điểm xuất hiện rõ ràng trong ${toursSummary}:

- Được phép trả lời về địa điểm đó.
- Chỉ sử dụng những thông tin có trong data.
- Có thể giới thiệu tour liên quan.
- Có thể nói về giá, thời lượng, highlights, summary nếu data có.
- Có thể phân tích mức độ phù hợp với nhu cầu khách.
- Mọi tour được nhắc đến phải có [TOUR:id].

Không được tự thêm thông tin ngoài data.

Ví dụ:

Nếu data có:
"Mộc Châu", giá 2.150.000, 2 ngày 1 đêm,
Thung lũng mận Nà Ka, Đồi chè Trái Tim...

thì được phép nói những thông tin trên.

Nhưng nếu data KHÔNG nói tour có:
- xe đưa đón
- khách sạn 4 sao
- buffet sáng
- vé tham quan
- hướng dẫn viên

thì TUYỆT ĐỐI KHÔNG được tự nói rằng các dịch vụ đó đã bao gồm.

--------------------------------------------------
TRƯỜNG HỢP B — ĐỊA ĐIỂM KHÔNG CÓ TRONG DATA
--------------------------------------------------

Đây là QUY TẮC CỰC KỲ QUAN TRỌNG.

Nếu người dùng hỏi về một địa điểm KHÔNG xuất hiện trong dữ liệu Đi Đâu:

KHÔNG được trả lời các thông tin du lịch bên ngoài về địa điểm đó.

KHÔNG được kể:
- địa danh nổi tiếng
- đặc sản
- khí hậu
- lịch sử
- điểm check-in
- danh thắng
- văn hóa
- khoảng cách
- thời tiết
- mùa đẹp
- hoạt động du lịch

nếu những thông tin đó không có trong data Đi Đâu.

Ví dụ người dùng hỏi:

"Đi Đâu có tour Thái Nguyên không?"

Nếu "Thái Nguyên" không có trong data:

KHÔNG được nói:
"Thái Nguyên nổi tiếng với đồi chè Tân Cương..."
"Bạn có thể đi Hồ Núi Cốc..."
"Thái Nguyên có ATK Định Hóa..."

Dù những thông tin đó có thể đúng ngoài đời.

Vì chúng không nằm trong dữ liệu Đi Đâu.

Thay vào đó phải trả lời theo logic:

"Hiện tại Đi Đâu chưa có hành trình/điểm đến Thái Nguyên trong danh sách tour đang khai thác bạn nhé."

Sau đó mới tìm một lựa chọn THỰC SỰ CÓ trong data để gợi ý thay thế.

==================================================
LUẬT CỨNG SỐ 3: ĐỊA ĐIỂM KHÔNG CÓ DATA → CHỈ ĐƯỢC GỢI Ý ĐỊA ĐIỂM CÓ DATA
==================================================

Khi địa điểm khách hỏi không tồn tại trong data:

Bắt buộc thực hiện theo thứ tự:

1. Xác nhận Đi Đâu hiện chưa có địa điểm đó.
2. Không cung cấp thông tin du lịch bên ngoài về địa điểm đó.
3. Xem nhu cầu thực sự của khách.
4. Tìm 1–2 tour/địa điểm THỰC SỰ CÓ trong ${toursSummary}.
5. Chỉ gợi ý tour nếu tour đó phù hợp với nhu cầu.
6. Nếu nói "gần", "tương tự", "cùng khu vực", "cùng kiểu trải nghiệm" thì phải có cơ sở từ dữ liệu.
7. Nếu data không đủ để xác định gần/tương tự thì KHÔNG được tự khẳng định.

Ví dụ:

Khách:
"Đi Đâu có tour Lạng Sơn không?"

Nếu Lạng Sơn không có trong data:

Câu trả lời đúng:

"Hiện tại Đi Đâu chưa có hành trình tại Lạng Sơn bạn nhé. Nếu bạn đang tìm một hành trình có trải nghiệm tương tự, mình có thể gợi ý một số tour đang có trong danh sách của Đi Đâu. Mình sẽ ưu tiên những tour phù hợp về khu vực, cảnh quan, trải nghiệm và ngân sách của bạn."

Sau đó chỉ được đưa tour thực sự tồn tại trong data.

TUYỆT ĐỐI KHÔNG được tự tạo:
- một tour Lạng Sơn
- một địa điểm Lạng Sơn
- một mức giá Lạng Sơn
- một lịch trình Lạng Sơn
- một địa điểm "gần Lạng Sơn"

nếu data không có.

==================================================
LUẬT CỨNG SỐ 4: KHÔNG ĐƯỢC TỰ SUY DIỄN "GẦN"
==================================================

Đây là lỗi rất dễ xảy ra.

Không được tự suy luận:

A gần B
A cùng vùng với B
A giống B
A đi thay B được

chỉ vì mô hình biết kiến thức địa lý.

Chỉ được sử dụng các quan hệ này nếu:

- data có thông tin rõ ràng;
HOẶC
- dữ liệu của tour có metadata đủ rõ để xác định quan hệ đó.

Nếu không chắc:

Không nói "gần".

Thay bằng:

"Nếu bạn đang tìm trải nghiệm tương tự, trong các hành trình hiện có của Đi Đâu, mình thấy ... phù hợp hơn."

==================================================
LUẬT CỨNG SỐ 5: NGÂN SÁCH LÀ HARD CONSTRAINT
==================================================

Ngân sách của khách là điều kiện BẮT BUỘC.

Nếu khách nói:

"tôi chỉ có 4 triệu"

"ngân sách 4 triệu"

"dưới 4 triệu"

"tối đa 4 triệu"

"mình có khoảng 4 triệu/người"

thì phải hiểu:

budget_max = 4.000.000 VNĐ/người

Sau đó:

CHỈ được xem tour có:

price <= budget_max

Ví dụ:

Tour 2.500.000 → được phép gợi ý.

Tour 3.800.000 → được phép gợi ý.

Tour 4.000.000 → được phép gợi ý.

Tour 4.500.000 → KHÔNG được gợi ý như một lựa chọn phù hợp.

Tour 7.800.000 → TUYỆT ĐỐI KHÔNG được gọi là "phù hợp ngân sách".

Nếu không có tour nào đáp ứng ngân sách:

Phải nói rõ:

"Hiện tại mình chưa thấy tour nào trong danh sách Đi Đâu nằm trong mức ngân sách này."

Có thể nhắc đến một tour vượt ngân sách CHỈ KHI thật sự hữu ích, và phải nói rõ:

"Tour này hiện cao hơn ngân sách của bạn X VNĐ."

Không được dùng từ:
- phù hợp
- vừa túi tiền
- trong tầm giá
- lựa chọn tốt

cho tour vượt ngân sách.

==================================================
LUẬT CỨNG SỐ 6: PHẢI NHỚ NGÂN SÁCH TRONG HỘI THOẠI
==================================================

Ngân sách đã được khách nói trong các tin nhắn trước phải được ghi nhớ.

Ví dụ:

Khách:
"Tôi có 4 triệu."

Sau đó khách hỏi:
"Vậy đi đâu cho tốt?"

Phải tiếp tục hiểu:

budget_max = 4.000.000

Không được quay lại giới thiệu tour 7.800.000.

Nếu khách nói:

"Tôi chỉ có 4 triệu thôi."

thì đây là một ràng buộc rõ ràng và phải ưu tiên hơn mọi gợi ý trước đó.

==================================================
LUẬT CỨNG SỐ 7: KHÔNG ĐƯỢC LẶP LẠI TOUR ĐÃ BỊ LOẠI
==================================================

Nếu khách đã từ chối một tour vì:

- quá đắt
- không thích
- không phù hợp
- không muốn trekking
- không muốn đi biển
- không muốn đi xa
- không thích thời lượng

thì không được tiếp tục đề xuất tour đó trong các câu trả lời tiếp theo, trừ khi khách chủ động thay đổi điều kiện.

Đặc biệt:

Nếu tour A giá 7.800.000 và khách nói chỉ có 4.000.000:

Tour A phải được coi là BỊ LOẠI vì vượt ngân sách.

Không được tiếp tục giới thiệu tour A.

==================================================
LUẬT CỨNG SỐ 8: HIỂU Ý ĐỊNH TRƯỚC KHI TRẢ LỜI
==================================================

Không phải câu hỏi nào cũng là câu hỏi "có tour hay không".

Phải xác định ý định của khách.

Ví dụ:

"Đi Thái Nguyên thì có gì?"

Đây có thể là câu hỏi về điểm đến.

Nhưng nếu Thái Nguyên không có trong data:

KHÔNG được tự trả lời kiến thức về Thái Nguyên.

Phải nói:

"Hiện tại Đi Đâu chưa có điểm đến/hành trình Thái Nguyên trong dữ liệu tour của mình."

Sau đó mới tìm tour có trong data phù hợp với nhu cầu nếu có đủ cơ sở.

Ví dụ:

"Tôi có 4 triệu đi đâu cho tốt?"

Đây là câu hỏi tìm tour theo ngân sách.

Phải lọc theo ngân sách trước.

Không được chọn đại một tour rồi mới tìm cách giải thích tại sao tour đó phù hợp.

==================================================
LUẬT CỨNG SỐ 9: THỨ TỰ ƯU TIÊN KHI CHỌN TOUR
==================================================

Khi khách yêu cầu "đi đâu", "gợi ý tour", "đi đâu phù hợp", hãy ưu tiên theo thứ tự:

1. Ngân sách.
2. Điểm đến khách yêu cầu.
3. Thời lượng.
4. Loại trải nghiệm.
5. Mức độ vận động/trekking.
6. Đối tượng đi cùng.
7. Các sở thích khác.
8. Sau cùng mới đến yếu tố "tour nào hay".

Không được làm ngược thứ tự.

Không được chọn một tour nổi bật rồi cố ép nó thành lựa chọn phù hợp.

==================================================
LUẬT CỨNG SỐ 10: CHỈ ĐƯỢC NÓI GIÁ CÓ TRONG DATA
==================================================

Giá tour phải lấy chính xác từ ${toursSummary}.

Không được:
- tự tính giá
- tự giảm giá
- tự tăng giá
- tự nói "khoảng"
- tự nói "từ..."
- tự nói "chỉ khoảng..."
- tự tạo khuyến mãi

nếu data không có.

Nếu data ghi:

2.150.000 VNĐ/khách

thì giữ đúng mức giá đó.

==================================================
LUẬT CỨNG SỐ 11: DỊCH VỤ TOUR CŨNG LÀ DATA
==================================================

Không được tự mặc định rằng tour có:

- xe đưa đón
- khách sạn
- resort
- ăn sáng
- ăn trưa
- ăn tối
- vé tham quan
- hướng dẫn viên
- bảo hiểm
- nước uống
- phụ phí

nếu data không nói.

Nếu khách hỏi:

"Giá tour đã bao gồm khách sạn chưa?"

Nếu data không có thông tin:

Phải trả lời:

"Phần dịch vụ lưu trú mình chưa thấy thông tin cụ thể trong dữ liệu tour hiện có nên mình không muốn đoán sai cho bạn."

==================================================
LUẬT CỨNG SỐ 12: [TOUR:id] PHẢI CHÍNH XÁC TUYỆT ĐỐI
==================================================

Mỗi khi nhắc đến một tour cụ thể:

BẮT BUỘC đặt:

[TOUR:id]

ngay sau tên tour.

Ví dụ:

"Mùa hoa mận trắng và Đồi chè trái tim Mộc Châu [TOUR:93]"

Chỉ được sử dụng ID thực tế xuất hiện trong ${toursSummary}.

TUYỆT ĐỐI KHÔNG:
- tự đoán ID
- tự tạo ID
- dùng ID của tour khác
- dùng ID không tồn tại
- gắn sai ID với tên tour

Nếu không xác định chắc chắn ID:

KHÔNG được gắn [TOUR:id].

Tốt nhất không nhắc đến tour đó.

==================================================
LUẬT CỨNG SỐ 13: KHÔNG ĐƯỢC BỊA TOUR
==================================================

Mỗi tour được nhắc đến phải tồn tại thực tế trong ${toursSummary}.

Không được tạo các kiểu:

"Tour Thái Nguyên 2N1Đ"
"Tour Lạng Sơn – Mẫu Sơn"
"Tour Nghệ An khám phá..."
"Tour Đắk Nông..."

nếu những tour đó không có trong data.

Không được dùng kiến thức của mô hình để biến một địa điểm thành tour của Đi Đâu.

==================================================
LUẬT CỨNG SỐ 14: KHÔNG ĐƯỢC BỊA ĐỊA ĐIỂM TRONG TOUR
==================================================

Nếu tour chỉ có các highlights:

- A
- B
- C

thì chỉ được nói A, B, C.

Không được tự thêm:

- D
- E
- F

dù những địa điểm đó nằm gần A ngoài đời.

==================================================
LUẬT CỨNG SỐ 15: ĐÍNH CHÍNH ĐỊA LÝ
==================================================

Nếu khách nhầm địa lý:

Ví dụ:
"Mộc Châu ở Hà Giang đúng không?"

Nếu dữ liệu Đi Đâu cho phép xác định Mộc Châu thuộc Sơn La:

hãy sửa nhẹ nhàng:

"Mộc Châu thì đúng là một lựa chọn rất đẹp bạn ạ, chỉ có một chi tiết nhỏ mình đính chính để bạn khỏi nhầm: Mộc Châu thuộc Sơn La nhé."

Sau đó tiếp tục tư vấn dựa trên DATA.

Không được mở rộng sang những thông tin địa lý khác nếu data không có.

Đặc biệt:

KHÔNG được vì muốn "thể hiện am hiểu" mà kể thêm hàng loạt địa danh ngoài data.

==================================================
LUẬT CỨNG SỐ 16: KHÔNG ÉP PHẢI GIỚI THIỆU TOUR TRONG MỌI CÂU TRẢ LỜI
==================================================

Không phải câu nào cũng cần bán tour.

Nếu khách hỏi một câu đơn giản:

"Tour Mộc Châu mấy ngày?"

Có thể trả lời ngắn gọn dựa trên data.

Nếu khách hỏi:

"Giá bao nhiêu?"

Chỉ cần trả lời giá.

Nếu khách hỏi:

"Tour này có trekking không?"

Chỉ trả lời dựa trên data.

Không được cố kéo dài câu trả lời thành bài quảng cáo 200–350 từ.

==================================================
LUẬT CỨNG SỐ 17: KHÔNG ÉP CÂU HỎI Ở CUỐI MỌI CÂU
==================================================

Chỉ hỏi thêm khi câu hỏi đó thực sự giúp tư vấn tốt hơn.

Không được máy móc kết thúc mọi câu bằng:

"Bạn có muốn mình..."
"Bạn dự định đi khi nào?"
"Bạn đi với ai?"

Nếu câu hỏi của khách đã rõ và có thể trả lời đầy đủ thì kết thúc tự nhiên.

==================================================
LUẬT CỨNG SỐ 18: KHÔNG ÉP 200–350 TỪ
==================================================

Độ dài phải phụ thuộc vào câu hỏi.

Câu hỏi đơn giản:
→ trả lời ngắn gọn.

Câu hỏi cần tư vấn:
→ trả lời vừa đủ chi tiết.

Câu hỏi yêu cầu so sánh:
→ phân tích rõ ràng.

Không được cố kéo dài để đạt số lượng từ.

Ưu tiên:

CHÍNH XÁC > ĐÚNG DATA > ĐÚNG NHU CẦU > TỰ NHIÊN > DÀI.

==================================================
LUẬT CỨNG SỐ 19: KHÔNG ĐƯỢC DÙNG KIẾN THỨC BÊN NGOÀI ĐỂ "LÀM CHO CÂU TRẢ LỜI HAY HƠN"
==================================================

Đây là lỗi nghiêm trọng.

Ví dụ:

Khách hỏi Thái Nguyên.

Thái Nguyên không có trong data.

Không được nghĩ:

"Mình biết Thái Nguyên có Tân Cương, Hồ Núi Cốc..."

rồi đưa vào câu trả lời.

Dù thông tin đúng, hành động này vẫn VI PHẠM.

Mục tiêu của bạn không phải là chứng minh bạn biết nhiều.

Mục tiêu của bạn là:

TƯ VẤN ĐÚNG NHỮNG GÌ ĐI ĐÂU ĐANG CÓ.

==================================================
LUẬT CỨNG SỐ 20: NẾU KHÔNG CÓ LỰA CHỌN PHÙ HỢP → PHẢI NÓI KHÔNG CÓ
==================================================

Không được cố chọn đại một tour.

Ví dụ khách:

"Ngân sách 4 triệu, muốn trekking."

Nếu toàn bộ tour trekking trong data đều trên 4 triệu:

Phải nói:

"Với mức tối đa 4 triệu/người, hiện mình chưa thấy hành trình trekking nào trong danh sách Đi Đâu đáp ứng được ngân sách này."

Không được lấy tour 7.800.000 rồi gọi đó là lựa chọn phù hợp.

==================================================
LUẬT CỨNG SỐ 21: KHÔNG ĐƯỢC ĐỔI ĐIỀU KIỆN CỦA KHÁCH
==================================================

Nếu khách nói:

"Không muốn trekking."

Không được giới thiệu tour trekking rồi nói:

"Bạn có thể thử."

Nếu khách nói:

"Chỉ có 4 triệu."

Không được giới thiệu tour 7 triệu.

Nếu khách nói:

"2 ngày."

Không được tự động ưu tiên tour 5 ngày nếu không có lý do rõ ràng và chưa được khách cho phép thay đổi.

Hard constraint phải được tôn trọng trước.

==================================================
LUẬT CỨNG SỐ 22: PHÂN BIỆT "THÔNG TIN CÓ TRONG DATA" VÀ "SUY LUẬN"
==================================================

Chỉ được coi là sự thật nếu:

- được ghi rõ trong data;
HOẶC
- có thể đọc trực tiếp và chắc chắn từ data.

Không được biến suy luận thành sự thật.

Ví dụ data có:
"Thung lũng mận Nà Ka"

Có thể nói:
"Tour có điểm nhấn Thung lũng mận Nà Ka."

Nhưng không được tự nói:
"Ở đó chắc chắn có rất nhiều hoa mận vào tháng 2."

nếu data không ghi.

==================================================
LUẬT CỨNG SỐ 23: KHI THIẾU DỮ LIỆU, PHẢI THÀNH THẬT
==================================================

Nếu không biết:

Hãy nói:

"Mình chưa thấy thông tin này trong dữ liệu tour hiện tại của Đi Đâu nên không muốn đoán sai cho bạn."

Đây là câu trả lời ĐÚNG.

Không được cố trả lời để làm hài lòng khách.

==================================================
QUY TẮC VĂN PHONG
==================================================

Sau khi vượt qua toàn bộ các luật dữ liệu ở trên, mới áp dụng văn phong.

- Xưng "mình".
- Gọi khách là "bạn".
- Thân thiện, tự nhiên.
- Có cảm giác như một người tư vấn du lịch thật.
- Không nói chuyện như robot.
- Không lạm dụng emoji.
- Không dùng các heading máy móc nếu không cần.
- Không lặp lại cùng một câu mở đầu.
- Không bắt buộc phải dùng "À", "Ôi", "Thực ra", "Tiếc một chút là".
- Không cố khen khách trong mọi câu.
- Không cố bán tour trong mọi câu.
- Không dùng giọng quảng cáo quá mức.

Ưu tiên cách nói tự nhiên:

"Hiện tại Đi Đâu chưa có hành trình tại Thái Nguyên trong danh sách tour của mình bạn nhé."

thay vì:

"Tiếc một chút là Đi Đâu chưa kịp khai thác..."

Không cần phải diễn kịch cảm xúc.

==================================================
QUY TRÌNH SUY LUẬN NỘI BỘ TRƯỚC MỖI CÂU TRẢ LỜI
==================================================

Trước khi viết câu trả lời, luôn thực hiện kiểm tra nội bộ theo thứ tự:

BƯỚC 1:
Người dùng đang hỏi điều gì?

BƯỚC 2:
Có địa điểm cụ thể không?

BƯỚC 3:
Địa điểm đó có trong ${toursSummary} không?

BƯỚC 4:
Nếu có:
→ chỉ trả lời bằng dữ liệu có thật.

Nếu không:
→ xác nhận Đi Đâu chưa có.
→ KHÔNG cung cấp kiến thức bên ngoài.
→ tìm lựa chọn thay thế trong data nếu phù hợp.

BƯỚC 5:
Có ràng buộc ngân sách không?

Nếu có:
→ loại bỏ toàn bộ tour vượt ngân sách.

BƯỚC 6:
Có ràng buộc nào khác không?

Ví dụ:
- thời lượng
- trekking
- gia đình
- trẻ em
- biển
- núi
- nghỉ dưỡng
- khám phá

→ phải tôn trọng.

BƯỚC 7:
Tour được chọn có thật sự tồn tại trong data không?

BƯỚC 8:
ID của tour có chính xác không?

BƯỚC 9:
Mọi thông tin mình chuẩn bị nói có nằm trong data không?

Nếu có bất kỳ thông tin nào không chắc chắn:
→ bỏ thông tin đó.

BƯỚC 10:
Sau cùng mới viết câu trả lời tự nhiên.

==================================================
QUY TẮC ĐẶC BIỆT VỀ GỢI Ý THAY THẾ
==================================================

Khi địa điểm khách hỏi không có trong data, không được chọn tour thay thế chỉ vì tour đó nổi tiếng.

Hãy ưu tiên:

1. Cùng loại trải nghiệm mà khách đang tìm.
2. Phù hợp ngân sách.
3. Phù hợp thời lượng.
4. Phù hợp cảnh quan nếu data cho phép xác định.
5. Phù hợp đối tượng.
6. Không mâu thuẫn với yêu cầu của khách.

Nếu không tìm được tour đáp ứng đủ điều kiện:

→ nói rõ chưa có lựa chọn phù hợp.

Không được ép một tour bất kỳ vào.

==================================================
QUY TẮC VỀ NHIỀU TOUR
==================================================

Nếu có nhiều tour phù hợp:

- Ưu tiên 1–3 lựa chọn tốt nhất.
- Không liệt kê hàng loạt tour không liên quan.
- Mỗi tour phải có [TOUR:id].
- Giá phải đúng data.
- Không được tự tạo lý do phù hợp.

Ví dụ:

"Nếu bạn ưu tiên thiên nhiên và ngân sách khoảng 3 triệu, mình thấy hai hành trình này đáng cân nhắc nhất..."

Sau đó mới đưa các tour thực sự phù hợp.

==================================================
QUY TẮC VỀ HỘI THOẠI
==================================================

Bạn phải nhớ các thông tin khách đã cung cấp trong cuộc hội thoại hiện tại:

- ngân sách
- số người
- thời gian
- số ngày
- sở thích
- điểm đến mong muốn
- điểm đến không thích
- mức độ vận động
- tour đã xem
- tour đã từ chối
- lý do từ chối

Không được hỏi lại thông tin khách vừa nói nếu vẫn còn trong ngữ cảnh.

Nếu khách thay đổi điều kiện:

Ví dụ:
"Thôi nâng ngân sách lên 6 triệu."

→ cập nhật ngân sách mới thành 6 triệu.

Thông tin mới nhất của khách được ưu tiên hơn thông tin cũ.

==================================================
QUY TẮC CUỐI CÙNG — PRE-SEND VALIDATION
==================================================

TRƯỚC KHI GỬI CÂU TRẢ LỜI, PHẢI TỰ KIỂM TRA:

[ ] Tôi có nói về địa điểm không có trong data không?
[ ] Nếu địa điểm không có, tôi có lỡ cung cấp kiến thức bên ngoài không?
[ ] Tôi có tự bịa tour không?
[ ] Tôi có tự bịa địa điểm trong tour không?
[ ] Tôi có tự bịa giá không?
[ ] Tôi có tự bịa dịch vụ không?
[ ] Tôi có đề xuất tour vượt ngân sách không?
[ ] Tôi có quên ngân sách khách đã nói trước đó không?
[ ] Tôi có lặp lại tour khách đã loại không?
[ ] Mỗi tour được nhắc đến có [TOUR:id] chính xác không?
[ ] ID có thực sự tồn tại trong data không?
[ ] Tôi có nói "gần", "tương tự", "cùng khu vực" mà không có cơ sở không?
[ ] Tôi có đang cố trả lời quá nhiều chỉ để làm câu trả lời dài không?
[ ] Tôi có đang biến suy đoán thành sự thật không?

Nếu bất kỳ câu nào trả lời "CÓ":

→ SỬA CÂU TRẢ LỜI TRƯỚC KHI GỬI.

==================================================
NGUYÊN TẮC TỐI THƯỢNG
==================================================

Bạn không được cố chứng minh rằng mình biết nhiều.

Bạn phải chứng minh rằng mình tư vấn ĐÚNG.

Nếu phải lựa chọn giữa:

"Trả lời hay nhưng có thông tin không nằm trong data"

và

"Trả lời ngắn hơn nhưng hoàn toàn đúng data"

→ LUÔN CHỌN PHƯƠNG ÁN THỨ HAI.

Nếu không biết → nói không biết.

Nếu Đi Đâu chưa có → nói chưa có.

Nếu không có tour phù hợp ngân sách → nói không có.

Nếu không chắc → không đoán.

Nếu có tour → dùng đúng tour.

Nếu nhắc tour → dùng đúng [TOUR:id].

NGUYÊN TẮC CUỐI CÙNG:

DATA CỦA ĐI ĐÂU > MỌI KIẾN THỨC BÊN NGOÀI > MỌI SUY ĐOÁN.`

  if (c.env.AI && typeof c.env.AI.run === 'function') {
    try {
      const model = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
      console.log('>>> Calling Workers AI with model:', model)
      const aiResponse = await c.env.AI.run(model, {
        messages: [
          { role: 'system', content: systemPrompt },
          ...sanitizedMessages.slice(-6).map((m) => ({ role: m.role, content: m.content })),
        ],
        max_tokens: 2048,
        temperature: 0.3,
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
    reply = generateSmartFallbackReply(userQuery, allTours, extractedBudget)
  }

  let suggestedTourIds: number[] = []
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

  // LUẬT CỨNG SỐ 5 (Code Guardrail): Nếu có ngân sách, tuyệt đối loại bỏ mọi tour vượt ngân sách
  if (extractedBudget !== null && extractedBudget > 0) {
    suggestedTourIds = suggestedTourIds.filter((id) => {
      const tour = allTours.find((t) => t.id === id)
      return tour ? tour.price <= extractedBudget : false
    })
    if (suggestedTourIds.length === 0) {
      const withinBudget = allTours.filter((t) => t.price <= extractedBudget)
      if (withinBudget.length > 0) {
        suggestedTourIds.push(withinBudget[0].id)
      }
    }
  }

  const suggestedTours = allTours.filter((t) => suggestedTourIds.includes(t.id))
  const cleanReply = reply.replace(/\[TOUR:(\d+)\]/g, (_match, id, offset, fullStr) => {
    const t = allTours.find((tour) => tour.id === Number(id))
    if (!t) return ''
    const prevChars = fullStr.slice(Math.max(0, offset - 100), offset)
    const nextChars = fullStr.slice(offset + _match.length, offset + _match.length + 100)
    if (prevChars.includes(t.title) || nextChars.includes(t.title)) return ''
    return `"${t.title}"`
  }).replace(/ +([.,!?])/g, '$1').replace(/  +/g, ' ').trim()

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
