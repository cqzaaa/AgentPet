// Shared classification for attachment ingestion and model message serialization.
export function isImageAttachment(name: string): boolean {
  return /\.(?:jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(name)
}
