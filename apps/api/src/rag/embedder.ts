export const EMBEDDING_MODEL = '@cf/baai/bge-m3'

export async function generateEmbedding(ai: any, text: string): Promise<number[]> {
  if (!ai || typeof ai.run !== 'function') {
    throw new Error('Cloudflare Workers AI (env.AI) is not available')
  }

  const cleanText = text.trim()
  if (!cleanText) {
    throw new Error('Cannot embed empty text')
  }

  const res = await ai.run(EMBEDDING_MODEL, { text: [cleanText] })
  
  if (res?.data && Array.isArray(res.data) && res.data[0]) {
    return res.data[0]
  }
  if (Array.isArray(res) && Array.isArray(res[0])) {
    return res[0]
  }
  if (Array.isArray(res) && typeof res[0] === 'number') {
    return res as number[]
  }

  throw new Error(`Unexpected embedding response structure from ${EMBEDDING_MODEL}: ${JSON.stringify(res).slice(0, 100)}`)
}

export async function generateBatchEmbeddings(ai: any, texts: string[], batchSize: number = 8): Promise<number[][]> {
  if (!ai || typeof ai.run !== 'function') {
    throw new Error('Cloudflare Workers AI (env.AI) is not available')
  }

  const allEmbeddings: number[][] = []

  for (let i = 0; i < texts.length; i += batchSize) {
    const chunkTexts = texts.slice(i, i + batchSize).map((t) => t.trim())
    const res = await ai.run(EMBEDDING_MODEL, { text: chunkTexts })

    let batchResult: number[][] = []
    if (res?.data && Array.isArray(res.data)) {
      batchResult = res.data
    } else if (Array.isArray(res) && Array.isArray(res[0])) {
      batchResult = res
    } else {
      throw new Error(`Unexpected batch embedding response structure: ${JSON.stringify(res).slice(0, 100)}`)
    }

    allEmbeddings.push(...batchResult)
  }

  return allEmbeddings
}
