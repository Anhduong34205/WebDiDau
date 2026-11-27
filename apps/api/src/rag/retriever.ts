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

  // 1. Vector Retrieval nếu có AI và VECTORIZE (thử chạy nếu AI còn hạn mức)
  if (env.AI && env.VECTORIZE) {
    try {
      const queryVector = await generateEmbedding(env.AI, cleanQuery)
      const rawMatches = await querySimilarTours(env.VECTORIZE, queryVector, 15)

      if (rawMatches && rawMatches.length > 0) {
        const matchesWithTour: Array<{
          tourId: number
          score: number
          title: string
          location: string
          tour: Tour
        }> = []

        // Cho phép dung sai 10% nếu khách dùng từ "khoảng / tầm / cỡ"
        const isSoftBudget = /(?:khoảng|tầm|cỡ|chừng|khoảng chừng|dưới tầm)/i.test(cleanQuery)
        const budgetCeiling = maxBudget !== null ? (isSoftBudget ? maxBudget * 1.12 : maxBudget) : null

        for (const m of rawMatches) {
          const idNum = Number(m.metadata?.tourId ?? m.id.replace('tour-', ''))
          const tour = tourMap.get(idNum)
          if (tour) {
            if (budgetCeiling !== null && tour.price > budgetCeiling) {
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

        if (matchesWithTour.length > 0) {
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
      }
    } catch (err) {
      console.warn('Vectorize embedding/retrieval unavailable, using semantic lexical ranking:', err)
    }
  }

  // 2. Semantic Lexical Ranking (Bộ chấm điểm ngữ nghĩa chuyên sâu khi AI / Vectorize bị quá tải)
  const qLower = cleanQuery.toLowerCase()

  // Phân tích chủ đích (Intent analysis)
  const wantsHighland = /(?:vùng cao|núi|đèo|cao nguyên|núi rừng|đại ngàn|tây bắc|đông bắc|sơn la|hà giang|lào cai|yên bái|sa pa|mộc châu|pleiku|gia lai|kon tum|đà lạt)/i.test(qLower)
  const wantsFlower = /(?:hoa|mùa hoa|ngắm hoa|hoa mận|dã quỳ|hoa sen|hoa ban|hoa tam giác mạch)/i.test(qLower)
  const wantsSea = /(?:biển|đảo|lặn biển|san hô|bãi tắm|bãi cát|hải sản|phú quốc|quy nhơn|cát bà|vịnh)/i.test(qLower)
  const wantsCloud = /(?:săn mây|mây|biển mây|chạm mây|tà xùa)/i.test(qLower)
  const wantsCulture = /(?:văn hóa|lịch sử|chùa|cổ kính|di sản|phố cổ|làng nghề|quan họ|đèn lồng|hội an|kinh bắc|huế)/i.test(qLower)

  const isSoftBudget = /(?:khoảng|tầm|cỡ|chừng|khoảng chừng|dưới tầm)/i.test(cleanQuery)
  const budgetCeiling = maxBudget !== null ? (isSoftBudget ? maxBudget * 1.15 : maxBudget) : null

  const scoredTours = allTours
    .filter((t) => t.active === 1)
    .filter((t) => {
      if (budgetCeiling !== null && t.price > budgetCeiling) return false
      return true
    })
    .map((tour) => {
      let score = 0
      const titleLower = tour.title.toLowerCase()
      const locationLower = tour.location.toLowerCase()
      const summaryLower = tour.summary.toLowerCase()
      const highlightsLower = tour.highlights.toLowerCase()
      const categoryLower = tour.category.toLowerCase()
      const allText = `${titleLower} ${locationLower} ${summaryLower} ${highlightsLower} ${categoryLower}`

      // Khớp chủ đề Hoa
      if (wantsFlower) {
        if (allText.includes('hoa') || allText.includes('mận') || allText.includes('dã quỳ') || allText.includes('sen')) {
          score += 40
        }
      }

      // Khớp chủ đề Vùng cao / Núi
      if (wantsHighland) {
        const highlandProvinces = ['hà giang', 'sơn la', 'lào cai', 'yên bái', 'cao bằng', 'hòa bình', 'lâm đồng', 'gia lai', 'kon tum', 'đắk lắk']
        if (highlandProvinces.some((p) => locationLower.includes(p))) {
          score += 35
        }
        if (allText.includes('núi') || allText.includes('đèo') || allText.includes('cao nguyên') || allText.includes('vùng cao')) {
          score += 25
        }
        // Phạt nặng nếu hỏi vùng cao mà tour là biển đảo
        if (categoryLower.includes('biển') || allText.includes('lặn biển') || allText.includes('bãi biển')) {
          score -= 60
        }
      }

      // Khớp chủ đề Biển đảo
      if (wantsSea) {
        if (categoryLower.includes('biển') || allText.includes('biển') || allText.includes('đảo') || allText.includes('san hô')) {
          score += 40
        }
        if (allText.includes('núi cao') || allText.includes('đèo')) {
          score -= 40
        }
      }

      // Khớp chủ đề Săn mây
      if (wantsCloud) {
        if (allText.includes('mây') || allText.includes('săn mây')) {
          score += 40
        }
      }

      // Khớp chủ đề Văn hóa
      if (wantsCulture) {
        if (categoryLower.includes('văn hóa') || allText.includes('chùa') || allText.includes('phố cổ') || allText.includes('quan họ') || allText.includes('di sản')) {
          score += 30
        }
      }

      // Khớp tên địa danh trực tiếp
      if (qLower.includes(locationLower)) score += 50
      if (qLower.includes(titleLower)) score += 80

      // Ưu tiên ngân sách gần nhất với ngân sách khách mong muốn
      if (maxBudget !== null) {
        const diff = Math.abs(maxBudget - tour.price)
        score += Math.max(0, 20 - (diff / 100000))
      }

      return { tour, score }
    })

  // Sắp xếp điểm giảm dần
  scoredTours.sort((a, b) => b.score - a.score)

  const relevantTours = scoredTours.slice(0, topK).map((item) => item.tour)

  return {
    relevantTours,
    ragContextText: formatToursAsContext(relevantTours),
    matches: scoredTours.slice(0, topK).map((item) => ({
      tourId: item.tour.id,
      score: Math.max(0, Math.min(1, item.score / 100)),
      title: item.tour.title,
      location: item.tour.location
    })),
    highestScore: scoredTours[0] ? Math.max(0, Math.min(1, scoredTours[0].score / 100)) : 0
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
