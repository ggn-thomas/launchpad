import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { config } from './env.js'

const OUTPUT = resolve(process.cwd(), 'metadata/token.json')

/**
 * Writes metadata/token.json from .env.
 *
 * The file is a build artifact: name and symbol have to match what goes on
 * chain, and keeping a second hand-edited copy of them is how they drift apart.
 * Edit .env and re-run this.
 */
async function imageContentType(url: string): Promise<string> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) })
    const type = response.headers.get('content-type')
    if (response.ok && type?.startsWith('image/')) return type
    console.warn(`  warning: ${url} returned ${response.status} ${type ?? ''}`.trimEnd())
  } catch {
    console.warn(`  warning: could not reach ${url}`)
  }
  return 'image/png'
}

function irysCommand(): string {
  const devnet = config.rpcUrl.includes('devnet')
  const network = devnet ? '-n devnet --provider-url https://api.devnet.solana.com ' : ''
  return (
    `irys upload metadata/token.json ${network}-t solana ` +
    `-w ${config.wallets.partner} --content-type application/json --no-confirmation`
  )
}

async function main(): Promise<void> {
  const { token } = config

  if (!token.image) {
    throw new Error(
      'TOKEN_IMAGE is empty. Upload your logo first, then put its URL in .env:\n' +
        `  irys upload metadata/logo.png ${
          config.rpcUrl.includes('devnet') ? '-n devnet --provider-url https://api.devnet.solana.com ' : ''
        }-t solana -w ${config.wallets.partner} --content-type image/png --no-confirmation`,
    )
  }

  const contentType = await imageContentType(token.image)

  // Only include links that are actually set; placeholder socials read worse
  // than none at all.
  const extensions = Object.fromEntries(
    Object.entries({
      website: token.website,
      twitter: token.twitter,
      telegram: token.telegram,
    }).filter(([, value]) => value !== ''),
  )

  const metadata = {
    name: token.name,
    symbol: token.symbol,
    description: token.description,
    image: token.image,
    ...(token.website ? { external_url: token.website } : {}),
    ...(Object.keys(extensions).length > 0 ? { extensions } : {}),
    properties: {
      files: [{ uri: token.image, type: contentType }],
      category: 'image',
    },
  }

  writeFileSync(OUTPUT, JSON.stringify(metadata, null, 2) + '\n')

  console.log(`Wrote ${OUTPUT}`)
  console.log(`  name        ${metadata.name}`)
  console.log(`  symbol      ${metadata.symbol}`)
  console.log(`  image       ${metadata.image} (${contentType})`)
  if (!metadata.description) console.log('  WARN        no TOKEN_DESCRIPTION — wallets will show nothing')
  if (Object.keys(extensions).length === 0) console.log('  note        no socials set')

  console.log('\nUpload it, then put the returned URL in TOKEN_URI:')
  console.log(`  ${irysCommand()}`)
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
