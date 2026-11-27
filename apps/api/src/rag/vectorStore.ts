import type { TourChunk } from './types'

export async function upsertTourVectors(
  vectorize: VectorizeIndex,
  chunks: TourChunk[],
  embeddings: number[][],
  batchSize: number = 20
): Promise<{ count: number }> {
  if (chunks.length !== embeddings.length) {
    throw new Error('Chunks count and embeddings count must match')
  }

  let totalUpserted = 0

  for (let i = 0; i < chunks.length; i += batchSize) {
    const chunkBatch = chunks.slice(i, i + batchSize)
    const embeddingBatch = embeddings.slice(i, i + batchSize)

    const vectors: VectorizeVector[] = chunkBatch.map((chunk, idx) => ({
      id: chunk.id,
      values: embeddingBatch[idx],
      metadata: {
        tourId: chunk.tourId,
        slug: chunk.slug,
        title: chunk.title,
        location: chunk.location,
        price: chunk.price,
        category: chunk.category,
        duration: chunk.duration,
        highlights: String(chunk.metadata.highlights || '').slice(0, 500)
      }
    }))

    await vectorize.upsert(vectors)
    totalUpserted += vectors.length
  }

  return { count: totalUpserted }
}

export async function querySimilarTours(
  vectorize: VectorizeIndex,
  queryVector: number[],
  topK: number = 8
): Promise<VectorizeMatch[]> {
  const result = await vectorize.query(queryVector, {
    topK,
    returnMetadata: 'all'
  })

  return result?.matches || []
}

export async function deleteTourVector(vectorize: VectorizeIndex, tourId: number): Promise<void> {
  try {
    await vectorize.deleteByIds([`tour-${tourId}`])
  } catch (err) {
    console.warn(`Could not delete vector for tour-${tourId}:`, err)
  }
}
