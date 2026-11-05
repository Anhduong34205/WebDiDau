CREATE TABLE IF NOT EXISTS tours (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  location TEXT NOT NULL,
  category TEXT NOT NULL,
  duration TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price > 0),
  rating REAL NOT NULL DEFAULT 5 CHECK (rating >= 0 AND rating <= 5),
  review_count INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL,
  image TEXT NOT NULL,
  image_alt TEXT NOT NULL,
  highlights TEXT NOT NULL,
  included TEXT NOT NULL,
  featured INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_tours_active_category ON tours (active, category);
CREATE INDEX IF NOT EXISTS idx_tours_featured_rating ON tours (featured, rating);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  order_number TEXT NOT NULL UNIQUE,
  customer_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  departure_date TEXT NOT NULL,
  total INTEGER NOT NULL CHECK (total >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'cancelled')),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders (created_at DESC);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id),
  tour_id INTEGER REFERENCES tours(id),
  tour_title TEXT NOT NULL,
  unit_price INTEGER NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0)
);

CREATE TABLE IF NOT EXISTS order_payments (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  payment_status TEXT NOT NULL CHECK (payment_status IN ('unpaid', 'paid')),
  payment_method TEXT CHECK (payment_method IS NULL OR payment_method = 'demo'),
  paid_at TEXT,
  CHECK (
    (payment_status = 'paid' AND payment_method = 'demo' AND paid_at IS NOT NULL) OR
    (payment_status = 'unpaid' AND payment_method IS NULL AND paid_at IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  email TEXT PRIMARY KEY,
  subscribed_at TEXT NOT NULL
);
