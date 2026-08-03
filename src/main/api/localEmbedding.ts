import { embedText, EMBEDDING_ENDPOINT } from '../embedding/embedding-client'

export async function getLocalEmbedding(text: string): Promise<number[] | null> {
  return embedText(text)
}

export async function initLocalEmbedding(): Promise<void> {
  console.log(`[Embedding] Using secured BGE-M3 service at ${EMBEDDING_ENDPOINT}.`)
}
