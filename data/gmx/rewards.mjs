/** Arbitrum v1 staking deployments, gmx-interface sdk/src/configs/contracts.ts, read 2026-10-11. */
export const GMX_REWARDS = Object.freeze({
  42161: Object.freeze({
    rewardRouter: "0x5E4766F932ce00aA4a1A82d3Da85adf15C5694A1",
    trackers: Object.freeze([
      Object.freeze({ name: "stakedGmx", address: "0x908C4D94D34924765f1eDc22A1DD098397c59dD4", reward: "esGMX" }),
      Object.freeze({ name: "feeGmx", address: "0xd2D1162512F927a7e282Ef43a362659E4F2a728F", reward: "WETH" }),
      Object.freeze({ name: "stakedGlp", address: "0x1aDDD80E6039594eE970E5872D247bf0414C8903", reward: "esGMX" }),
      Object.freeze({ name: "feeGlp", address: "0x4e971a87900b931fF39d1Aad67697F49835400b6", reward: "WETH" }),
    ]),
  }),
});
export const GMX_KEEPER_ROLES = Object.freeze(["ORDER_KEEPER", "FROZEN_ORDER_KEEPER", "LIQUIDATION_KEEPER", "ADL_KEEPER"]);
