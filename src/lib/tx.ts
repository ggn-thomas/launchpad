import type { Connection, Keypair, Transaction } from '@solana/web3.js'
import { config } from '../env.js'

const isDevnet = () => config.rpcUrl.includes('devnet')

export function explorerTx(signature: string): string {
  return `https://solscan.io/tx/${signature}${isDevnet() ? '?cluster=devnet' : ''}`
}

export function explorerAddress(address: string): string {
  return `https://solscan.io/token/${address}${isDevnet() ? '?cluster=devnet' : ''}`
}

/**
 * Signs, simulates and sends a transaction built by the SDK.
 *
 * The SDK returns unsigned transactions with no blockhash, so we attach a fresh
 * one here. We simulate first: a failed simulation reports the program's own
 * error logs, which say far more than the confirmation error would.
 */
export async function sendTransaction(
  connection: Connection,
  transaction: Transaction,
  signers: Keypair[],
  label: string,
): Promise<string> {
  const payer = signers[0]
  if (!payer) throw new Error(`${label}: at least one signer is required`)

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  transaction.recentBlockhash = blockhash
  transaction.lastValidBlockHeight = lastValidBlockHeight
  transaction.feePayer = payer.publicKey
  transaction.sign(...signers)

  const simulation = await connection.simulateTransaction(transaction)
  if (simulation.value.err) {
    const logs = simulation.value.logs?.join('\n') ?? '(no logs returned)'
    throw new Error(`${label} failed simulation: ${JSON.stringify(simulation.value.err)}\n${logs}`)
  }

  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    preflightCommitment: 'confirmed',
  })
  const result = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed',
  )
  if (result.value.err) {
    throw new Error(`${label} landed but failed: ${JSON.stringify(result.value.err)}`)
  }

  console.log(`  ${label} -> ${explorerTx(signature)}`)
  return signature
}
