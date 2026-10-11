/** Credential-free accrued-fee preflight. No private wallet binding, signing, or broadcast. */
import { Interface, Transaction, keccak256 } from 'ethers';
import { GMX_CHAINS } from '../../data/gmx/contracts.mjs';
import { GMX_REWARDS } from '../../data/gmx/rewards.mjs';
import { createGmxAdapter } from '../gmx-adapter.mjs';
import { createGmxPublicReader } from './public-reader.mjs';

const abi = new Interface(['function feeGlpTracker() view returns (address)', 'function feeGmxTracker() view returns (address)',
  'function weth() view returns (address)', 'function claimable(address) view returns (uint256)', 'function balanceOf(address) view returns (uint256)']);
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const json = (value) => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v));
export async function prepareGmxFeeHarvest({ provider, account, now = new Date().toISOString(), maxGasShareBps = 2500, transaction: exactTransaction }) {
  if (!/^0x[0-9a-fA-F]{40}$/u.test(account)) throw new TypeError('wallet-address-required');
  if (!Number.isSafeInteger(maxGasShareBps) || maxGasShareBps <= 0 || maxGasShareBps > 2500) throw new RangeError('gas share must be 1..2500 bps');
  const chainId = 42161, deployment = GMX_CHAINS[chainId], rewards = GMX_REWARDS[chainId];
  if ((await provider.getNetwork()).chainId !== BigInt(chainId)) throw new Error('provider-chain-mismatch');
  const block = await provider.getBlock('latest');
  const blockTag = `0x${block.number.toString(16)}`;
  const read = async (to, method, args = []) => abi.decodeFunctionResult(method, await provider.send('eth_call', [{ to, data: abi.encodeFunctionData(method, args) }, blockTag]))[0];
  const [glpTracker, gmxTracker, weth, code] = await Promise.all([
    read(rewards.rewardRouter, 'feeGlpTracker'), read(rewards.rewardRouter, 'feeGmxTracker'), read(rewards.rewardRouter, 'weth'), provider.send('eth_getCode', [rewards.rewardRouter, blockTag]),
  ]);
  if (!same(glpTracker, rewards.trackers.find((r) => r.name === 'feeGlp').address) || !same(gmxTracker, rewards.trackers.find((r) => r.name === 'feeGmx').address) || !same(weth, deployment.wnt) || code === '0x') throw new Error('deployed-reward-route-mismatch');
  const [glpClaimable, gmxClaimable, wethBefore, nativeHex] = await Promise.all([
    read(glpTracker, 'claimable', [account]), read(gmxTracker, 'claimable', [account]), read(weth, 'balanceOf', [account]), provider.send('eth_getBalance', [account, blockTag]),
  ]);
  const boundary = { chainId, blockNumber: String(block.number), blockHash: block.hash, blockTimestamp: String(block.timestamp), observedAt: now, verified: false };
  const claimable = glpClaimable + gmxClaimable, nativeBefore = BigInt(nativeHex);
  if (claimable === 0n) {
    boundary.verified = same((await provider.getBlock(block.number)).hash, block.hash);
    return json({ type: 'GmxFeeHarvestPreflight', actionable: false, reason: 'no-accrued-weth-fees', account, boundary, glpClaimable, gmxClaimable, wethBefore, nativeBefore });
  }
  const quote = await createGmxPublicReader().get('/prices/tickers');
  const ticker = quote.body.find((t) => same(t.tokenAddress, weth));
  const priceUsd = ticker && (Number(ticker.minPrice) + Number(ticker.maxPrice)) / 2e12;
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) throw new Error('weth-quote-invalid');
  const rewardUsd = Number(claimable) / 1e18 * priceUsd;
  const grant = { id: `gmx-fee-harvest:${account}:${block.number}`, type: 'RevocableBrokerageAuthorityGrant', adapter: 'gmx', chainId, account,
    scopes: ['rewards:build'], validUntil: new Date(Date.parse(now) + 300000).toISOString(), limits: { maxValuePerTransactionUsd: rewardUsd, allowedContracts: [rewards.rewardRouter] } };
  const plan = createGmxAdapter({ rpc: ({ method, params }) => provider.send(method, params) }).buildFeeClaim({ grant, valueUsd: rewardUsd, now });
  const intent = plan.transactions[0];
  const [result, estimate, fees, nonce] = await Promise.all([
    provider.send('eth_call', [{ from: account, to: intent.to, data: intent.data, value: '0x0' }, blockTag]), provider.estimateGas(intent), provider.getFeeData(), provider.getTransactionCount(account, 'pending'),
  ]);
  if (nonce !== await provider.getTransactionCount(account, 'latest')) throw new Error('wallet-has-pending-transactions');
  if (!fees.gasPrice) throw new Error('gas-price-unavailable');
  const parsed = exactTransaction ? Transaction.from(exactTransaction) : null;
  if (parsed && (!same(parsed.to, intent.to) || !same(parsed.data, intent.data) || parsed.value !== 0n || Number(parsed.chainId) !== chainId || parsed.nonce !== nonce || parsed.gasLimit < estimate || parsed.gasPrice < fees.gasPrice)) throw new Error('exact-fee-transaction-no-longer-qualifies');
  const gasLimit = parsed?.gasLimit ?? (estimate * 120n + 99n) / 100n, gasPrice = parsed?.gasPrice ?? (fees.gasPrice * 125n + 99n) / 100n;
  const maxGasWei = gasLimit * gasPrice;
  if (maxGasWei > claimable * BigInt(maxGasShareBps) / 10000n || maxGasWei >= nativeBefore) throw new Error('fee-claim-not-economic-or-unfunded');
  const transaction = exactTransaction ?? { to: intent.to, data: intent.data, value: '0', chainId, nonce, gasLimit: gasLimit.toString(), gasPrice: gasPrice.toString(), type: 0 };
  const transactionHash = Transaction.from(transaction).unsignedHash;
  boundary.verified = same((await provider.getBlock(block.number)).hash, block.hash);
  if (!boundary.verified) throw new Error('preflight-boundary-no-longer-canonical');
  return json({ type: 'GmxFeeHarvestPreflight', actionable: true, account, chainId, boundary, plan, transaction, transactionHash, claimableWei: claimable, glpClaimable, gmxClaimable, wethBefore, nativeBefore,
    rewardUsd, maxGasWei, maxGasUsd: Number(maxGasWei) / 1e18 * priceUsd, quoteSource: quote.url, quoteRaw: ticker,
    simulation: { success: true, account, blockHash: block.hash, transactionHash, result },
    protocolProof: { checked: true, protocol: 'gmx', target: rewards.rewardRouter, blockHash: block.hash, codeHash: keccak256(code), glpTracker, gmxTracker, weth },
    economics: { unit: 'native-wei', benefitLowerWei: claimable.toString(), gasCostUpperWei: maxGasWei.toString(), otherCostUpperWei: '0' },
    strategyProof: { kind: 'accrued-fee-harvest', newExposure: false, claimableWei: claimable.toString(), blockHash: block.hash, transactionHash },
  });
}
