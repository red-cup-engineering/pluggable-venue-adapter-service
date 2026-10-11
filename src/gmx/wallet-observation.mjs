/** Public wallet and reward reads. Caller supplies a block-pinned RPC port. */
import { AbiCoder, Interface, keccak256 } from "ethers";
import { GMX_CHAINS } from "../../data/gmx/contracts.mjs";
import { GMX_REWARDS, GMX_KEEPER_ROLES } from "../../data/gmx/rewards.mjs";
import { createGmxAdapter } from "../gmx-adapter.mjs";

const abi = new Interface([
  "function balanceOf(address) view returns (uint256)",
  "function claimable(address) view returns (uint256)",
  "function distributor() view returns (address)",
  "function tokensPerInterval() view returns (uint256)",
  "function rewardToken() view returns (address)",
  "function hasRole(address,bytes32) view returns (bool)",
]);
const coder = AbiCoder.defaultAbiCoder();

export async function observeGmxWallet({ account, chainId = 42161, rpc, tokens = [], blockTag = "latest", now = new Date().toISOString() }) {
  const chain = GMX_CHAINS[chainId];
  if (!chain || typeof rpc !== "function") throw new TypeError("gmx-wallet-observer-configuration-invalid");
  const adapter = createGmxAdapter({ chainId, rpc, blockTag });
  const grant = { id: "public-wallet-read", type: "RevocableBrokerageAuthorityGrant", adapter: "gmx", chainId, account,
    scopes: ["account:read", "positions:read", "orders:read"], validUntil: new Date(Date.parse(now) + 60_000).toISOString() };
  const call = async (to, method, args = []) => abi.decodeFunctionResult(method, await rpc({
    method: "eth_call", params: [{ to, data: abi.encodeFunctionData(method, args) }, blockTag],
  }))[0];
  const failures = [];
  const observed = async (kind, work) => {
    try { return await work(); }
    catch (error) { failures.push({ kind, reason: String(error.message ?? error) }); return null; }
  };
  const [balances, positions, orders, roles, rewards] = await Promise.all([
    adapter.readAccount({ grant, tokens: [...new Set([chain.usdc, chain.wnt, ...tokens])], now }),
    adapter.listPositions({ grant, now }),
    adapter.listOrders({ grant, now }),
    Promise.all(GMX_KEEPER_ROLES.map(async (role) => ({ role, granted: await observed(`role:${role}`,
      () => call(chain.roleStore, "hasRole", [account, keccak256(coder.encode(["string"], [role]))])) }))),
    Promise.all((GMX_REWARDS[chainId]?.trackers ?? []).map(async (tracker) => {
      const reading = await observed(`rewards:${tracker.name}`, async () => {
        const [balance, claimable, distributor, rewardToken] = await Promise.all([
          call(tracker.address, "balanceOf", [account]), call(tracker.address, "claimable", [account]),
          call(tracker.address, "distributor"), call(tracker.address, "rewardToken"),
        ]);
        const emission = await call(distributor, "tokensPerInterval");
        return { balanceRaw: balance.toString(), claimableRaw: claimable.toString(), distributor,
          rewardToken, emissionRawPerSecond: emission.toString() };
      });
      return { ...tracker, reading };
    })),
  ]);
  for (const receipt of [balances, positions, orders]) if (receipt.outcome !== "accepted") failures.push(receipt.error);
  for (const [kind, receipt] of [['positions', positions], ['orders', orders]]) if (receipt.payload?.range?.complete === false) failures.push({ kind, reason: 'bounded page is full; full coverage unproved' });
  return { type: "GmxWalletObservation", version: 1, account, chainId, observedAt: now,
    balances: balances.payload, positions: positions.payload?.positions ?? null, orders: orders.payload?.orders ?? null,
    roles, rewards, coverage: { positions: positions.payload?.range ?? null, orders: orders.payload?.range ?? null }, failures };
}
