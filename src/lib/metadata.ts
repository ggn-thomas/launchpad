/**
 * Validates that TOKEN_URI resolves to usable token metadata.
 *
 * Worth doing before every launch: the mainnet profile makes the metadata
 * immutable, so a URI that returns the wrong thing cannot be corrected once
 * the pool exists.
 */
export type MetadataCheck = { ok: boolean; lines: string[] }

type TokenMetadata = {
  name?: unknown
  symbol?: unknown
  description?: unknown
  image?: unknown
}

async function head(url: string): Promise<Response | null> {
  try {
    return await fetch(url, { method: 'GET', signal: AbortSignal.timeout(8000) })
  } catch {
    return null
  }
}

export async function checkTokenUri(
  uri: string,
  expected: { name: string; symbol: string },
): Promise<MetadataCheck> {
  const lines: string[] = []
  const fail = (message: string) => {
    lines.push(`  FAIL  ${message}`)
    return { ok: false, lines }
  }

  const response = await head(uri)
  if (!response) return fail(`${uri} is unreachable`)
  if (!response.ok) return fail(`${uri} returned HTTP ${response.status}`)

  const contentType = response.headers.get('content-type') ?? 'unknown'
  let metadata: TokenMetadata
  try {
    metadata = (await response.json()) as TokenMetadata
  } catch {
    return fail(
      `TOKEN_URI must return JSON, got ${contentType}. ` +
        `Point it at the metadata file, not at the image.`,
    )
  }
  lines.push(`  ok    JSON metadata (${contentType})`)

  if (typeof metadata.name !== 'string' || !metadata.name) lines.push('  WARN  no "name" field')
  else if (metadata.name !== expected.name) {
    lines.push(`  WARN  name "${metadata.name}" differs from TOKEN_NAME "${expected.name}"`)
  }

  if (typeof metadata.symbol !== 'string' || !metadata.symbol) lines.push('  WARN  no "symbol" field')
  else if (metadata.symbol !== expected.symbol) {
    lines.push(`  WARN  symbol "${metadata.symbol}" differs from TOKEN_SYMBOL "${expected.symbol}"`)
  }

  if (typeof metadata.description !== 'string' || !metadata.description) {
    lines.push('  WARN  no "description" field — wallets will show nothing')
  }

  if (typeof metadata.image !== 'string' || !metadata.image) {
    return fail('no "image" field — the token will have no icon anywhere')
  }

  const image = await head(metadata.image)
  if (!image || !image.ok) return fail(`image ${metadata.image} is unreachable`)
  const imageType = image.headers.get('content-type') ?? 'unknown'
  if (!imageType.startsWith('image/')) {
    return fail(`image URL returns ${imageType}, not an image`)
  }
  lines.push(`  ok    image loads (${imageType})`)

  const host = new URL(uri).host
  if (host.includes('github') || host.includes('githubusercontent')) {
    lines.push('  WARN  hosted on GitHub — rate limited and not permanent. See metadata/README.md')
  }

  return { ok: true, lines }
}
