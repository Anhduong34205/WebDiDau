import type { Tour, TourChunk } from './types'

export function buildTourChunk(tour: Tour): TourChunk {
  const formattedPrice = tour.price.toLocaleString('vi-VN')
  const text = [
    `Tour: ${tour.title}`,
    `Địa danh / Tỉnh thành: ${tour.location}`,
    `Thể loại: ${tour.category}`,
    `Thời lượng: ${tour.duration}`,
    `Giá niêm yết: ${formattedPrice} ₫/khách (${tour.price} VNĐ)`,
    `Đặc điểm & Tóm tắt: ${tour.summary}`,
    `Điểm tham quan & Trải nghiệm nổi bật: ${tour.highlights}`,
    `Dịch vụ trọn gói bao gồm: ${tour.included}`
  ].join('\n')

  return {
    id: `tour-${tour.id}`,
    tourId: tour.id,
    slug: tour.slug,
    title: tour.title,
    location: tour.location,
    price: tour.price,
    category: tour.category,
    duration: tour.duration,
    text,
    metadata: {
      tourId: tour.id,
      slug: tour.slug,
      title: tour.title,
      location: tour.location,
      price: tour.price,
      category: tour.category,
      duration: tour.duration,
      highlights: tour.highlights
    }
  }
}

export function chunkAllTours(tours: Tour[]): TourChunk[] {
  return tours.map((t) => buildTourChunk(t))
}
