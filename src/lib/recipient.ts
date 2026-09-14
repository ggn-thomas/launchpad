import { SystemProgram, type Connection, type PublicKey } from '@solana/web3.js'

/**
 * Refuses addresses that cannot hold and later spend tokens.
 *
 * A token transfer to the wrong kind of address is irreversible. The classic
 * mistake is pasting a Squads multisig *account* instead of its *vault*: the
 * tokens land in an account nobody can sign for. Wallets and vaults either do
 * not exist yet or are plain system accounts with no data; anything owned by a
 * program and carrying data — a multisig config, a token account, a pool — is
 * not a valid owner.
 *
 * Only meaningful against the cluster the address lives on: a mainnet
 * multisig queried through a devnet RPC simply looks nonexistent.
 */
export async function checkRecipient(
  connection: Connection,
  address: PublicKey,
): Promise<{ ok: true; note: string } | { ok: false; reason: string }> {
  const info = await connection.getAccountInfo(address)
  if (!info) return { ok: true, note: 'not created yet on this cluster (normal for a fresh vault)' }
  if (info.executable) return { ok: false, reason: 'this is a program, not a wallet' }
  if (info.data.length > 0 && !info.owner.equals(SystemProgram.programId)) {
    return {
      ok: false,
      reason:
        `an account owned by program ${info.owner.toBase58()}, not a wallet ` +
        '(for a Squads multisig, use the Vault address, not the multisig address)',
    }
  }
  return { ok: true, note: 'wallet' }
}
