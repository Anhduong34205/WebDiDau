export type Tour = {
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

export type Cart = { items: { tour: Tour; qty: number }[]; total: number; count: number }
export type Order = {
  id: string
  order_number: string
  customer_name: string
  email: string
  phone: string
  departure_date: string
  total: number
  status: 'pending' | 'confirmed' | 'cancelled'
  payment_status: 'unpaid' | 'paid'
  payment_method: 'demo' | null
  created_at: string
  items: string
}

export type OrderLookupResult = Pick<
  Order,
  'order_number' | 'departure_date' | 'total' | 'status' | 'payment_status' | 'items'
>

const cartId = (() => {
  try {
    let id = localStorage.getItem('journey-cart-id')
    if (!id) localStorage.setItem('journey-cart-id', (id = crypto.randomUUID()))
    return id
  } catch {
    return crypto.randomUUID()
  }
})()

async function req<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-cart-id': cartId,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null
    throw new Error(body?.error || `${res.status} ${res.statusText}`)
  }
  return res.json()
}

export const api = {
  tours: (filters: { q?: string; category?: string; maxPrice?: number; sort?: string } = {}) => {
    const params = new URLSearchParams()
    Object.entries(filters).forEach(([key, value]) => {
      if (value !== undefined && value !== '') params.set(key, String(value))
    })
    return req<Tour[]>(`/tours?${params}`)
  },
  categories: () => req<string[]>('/categories'),
  cart: () => req<Cart>('/cart'),
  add: (tourId: number) =>
    req<Cart>('/cart/items', { method: 'POST', body: JSON.stringify({ tourId }) }),
  setQty: (tourId: number, qty: number) =>
    req<Cart>(`/cart/items/${tourId}`, { method: 'PUT', body: JSON.stringify({ qty }) }),
  clear: () => req<Cart>('/cart', { method: 'DELETE' }),
  order: (customer: {
    name: string
    email: string
    phone: string
    departureDate: string
    paymentDemo: boolean
  }) =>
    req<{ id: string; orderNumber: string; total: number; paymentStatus: 'unpaid' | 'paid' }>('/orders', {
      method: 'POST', body: JSON.stringify(customer),
    }),
  lookupOrders: (lookupType: 'orderNumber' | 'email' | 'phone', value: string) =>
    req<OrderLookupResult[]>('/orders/lookup', {
      method: 'POST', body: JSON.stringify({ lookupType, value }),
    }),
  subscribe: (email: string) =>
    req<{ ok: boolean }>('/newsletter', { method: 'POST', body: JSON.stringify({ email }) }),
  adminTours: (token: string) => req<Tour[]>('/admin/tours', {}, token),
  adminOrders: (token: string) => req<Order[]>('/admin/orders', {}, token),
  createTour: (token: string, tour: Omit<Tour, 'id'>) =>
    req<{ id: number }>('/admin/tours', { method: 'POST', body: JSON.stringify(tour) }, token),
  updateTour: (token: string, id: number, tour: Omit<Tour, 'id'>) =>
    req<{ ok: boolean }>(`/admin/tours/${id}`, { method: 'PUT', body: JSON.stringify(tour) }, token),
  archiveTour: (token: string, id: number) =>
    req<{ ok: boolean }>(`/admin/tours/${id}`, { method: 'DELETE' }, token),
  updateOrder: (token: string, id: string, status: Order['status']) =>
    req<{ ok: boolean }>(`/admin/orders/${id}`, {
      method: 'PATCH', body: JSON.stringify({ status }),
    }, token),
}

export const vnd = (n: number) =>
  new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(n)
