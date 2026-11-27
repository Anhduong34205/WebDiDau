export interface Tour {
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

export interface TourChunk {
  id: string
  tourId: number
  slug: string
  title: string
  location: string
  price: number
  category: string
  duration: string
  text: string
  metadata: {
    tourId: number
    slug: string
    title: string
    location: string
    price: number
    category: string
    duration: string
    highlights: string
    [key: string]: string | number
  }
}

export interface RagRetrievalResult {
  relevantTours: Tour[]
  ragContextText: string
  matches: Array<{
    tourId: number
    score: number
    title: string
    location: string
  }>
  highestScore: number
}
