import type { Tour, RagRetrievalResult } from './types'
import { generateEmbedding } from './embedder'
import { querySimilarTours } from './vectorStore'

export interface RetrieveOptions {
  topK?: number
  maxBudget?: number | null
  targetLocation?: string | null
}

export async function retrieveRelevantContext(
  query: string,
  env: { AI?: any; VECTORIZE?: VectorizeIndex },
  allTours: Tour[],
  options: RetrieveOptions = {}
): Promise<RagRetrievalResult> {
  const topK = options.topK ?? 4
  const maxBudget = options.maxBudget !== undefined ? options.maxBudget : null
  const tourMap = new Map<number, Tour>()
  allTours.forEach((t) => tourMap.set(t.id, t))

  const cleanQuery = query.trim()
  if (!cleanQuery) {
    return {
      relevantTours: allTours.slice(0, topK),
      ragContextText: formatToursAsContext(allTours.slice(0, topK)),
      matches: [],
      highestScore: 0
    }
  }

  // 1. Vector Retrieval nếu có AI và VECTORIZE
  if (env.AI && env.VECTORIZE) {
    try {
      const queryVector = await generateEmbedding(env.AI, cleanQuery)
      const rawMatches = await querySimilarTours(env.VECTORIZE, queryVector, 12)

      if (rawMatches && rawMatches.length > 0) {
        const matchesWithTour: Array<{
          tourId: number
          score: number
          title: string
          location: string
          tour: Tour
        }> = []

        for (const m of rawMatches) {
          const idNum = Number(m.metadata?.tourId ?? m.id.replace('tour-', ''))
          const tour = tourMap.get(idNum)
          if (tour) {
            // Lọc ngân sách nếu khách có giới hạn ngân sách
            if (maxBudget !== null && tour.price > maxBudget) {
              continue
            }
            matchesWithTour.push({
              tourId: tour.id,
              score: m.score,
              title: tour.title,
              location: tour.location,
              tour
            })
          }
        }

        const selectedMatches = matchesWithTour.slice(0, topK)
        const relevantTours = selectedMatches.map((item) => item.tour)
        const highestScore = rawMatches[0]?.score || 0

        return {
          relevantTours,
          ragContextText: formatToursAsContext(relevantTours),
          matches: selectedMatches.map((item) => ({
            tourId: item.tourId,
            score: item.score,
            title: item.title,
            location: item.location
          })),
          highestScore
        }
      }
    } catch (err) {
      console.warn('Vectorize retrieval failed, falling back to lexical matching:', err)
    }
  }

  // 2. Fallback tìm kiếm dựa trên từ khóa & ngân sách khi Vectorize chưa sẵn sàng
  const qLower = cleanQuery.toLowerCase()
  let filteredTours = allTours.filter((t) => {
    if (maxBudget !== null && t.price > maxBudget) return false
    return true
  })

  // Sắp xếp theo mức độ khớp từ khóa
  filteredTours.sort((a, b) => {
    const aMatch =
      (qLower.includes(a.location.toLowerCase()) ? 5 : 0) +
      (qLower.includes(a.title.toLowerCase()) ? 8 : 0) +
      (qLower.includes(a.category.toLowerCase()) ? 3 : 0)
    const bMatch =
      (qLower.includes(b.location.toLowerCase()) ? 5 : 0) +
      (qLower.includes(b.title.toLowerCase()) ? 8 : 0) +
      (qLower.includes(b.category.toLowerCase()) ? 3 : 0)
    return bMatch - aMatch
  })

  const relevantTours = filteredTours.slice(0, topK)

  return {
    relevantTours,
    ragContextText: formatToursAsContext(relevantTours),
    matches: relevantTours.map((t) => ({
      tourId: t.id,
      score: 1.0,
      title: t.title,
      location: t.location
    })),
    highestScore: 1.0
  }
}

function formatToursAsContext(tours: Tour[]): string {
  if (tours.length === 0) {
    return 'Hệ thống tìm kiếm không tìm thấy tour nào hoàn toàn thỏa mãn các điều kiện tìm kiếm khắt khe này.'
  }

  return tours
    .map((t, idx) => {
      const formattedPrice = t.price.toLocaleString('vi-VN')
      return [
        `[HÀNH TRÌNH ${idx + 1}]`,
        `- Tên tour: ${t.title}`,
        `- Địa danh / Tỉnh: ${t.location}`,
        `- Thể loại: ${t.category}`,
        `- Thời lượng: ${t.duration}`,
        `- Giá niêm yết: ${formattedPrice} ₫/khách (${t.price} VNĐ)`,
        `- Tóm tắt trải nghiệm: ${t.summary}`,
        `- Điểm nhấn nổi bật: ${t.highlights}`,
        `- Trọn gói bao gồm: ${t.included}`
      ].join('\n')
    })
    .join('\n\n')
}
