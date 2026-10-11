/** GMX v2 deployment and ABI data. Verified against https://docs.gmx.io/docs/api/contracts/addresses/ on 2026-10-11. */
export const GMX_CHAINS = Object.freeze({
  42161: Object.freeze({
    name: "arbitrum", api: "https://arbitrum-api.gmxinfra.io", apiFallbacks: Object.freeze(["https://arbitrum-api-fallback.gmxinfra.io", "https://arbitrum-api-fallback.gmxinfra2.io"]), roleStore: "0x3c3d99FD298f679DBC2CEcd132b4eC4d0F5e6e72",
    dataStore: "0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8", exchangeRouter: "0x7dE39FF2e232A2203196788d37e234cF8F1b83f1", router: "0x7452c558d45f8afC8c83dAe62C3f8A5BE19c71f6",
    orderVault: "0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5", depositVault: "0xF89e77e8Dc11691C9e8757e84aaFbCD8A67d7A55", withdrawalVault: "0x0628D46b5D145f183AdB6Ef1f2c97eD1C4701C55",
    reader: "0xfA26cBb46e2614609406de08CA1Dc7f70a684184", glvRouter: "0x167540D2DFF14120365CfDDF2F86e3045D4fa712", glvVault: "0x393053B58f9678C9c28c2cE941fF6cac49C3F8f9",
    wnt: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  }),
  43114: Object.freeze({
    name: "avalanche", api: "https://avalanche-api.gmxinfra.io", apiFallbacks: Object.freeze(["https://avalanche-api-fallback.gmxinfra.io", "https://avalanche-api-fallback.gmxinfra2.io"]), roleStore: "0xA44F830B6a2B6fa76657a3B92C1fe74fcB7C6AfD",
    dataStore: "0x2F0b22339414ADeD7D5F06f9D604c7fF5b2fe3f6", exchangeRouter: "0xc002Db96E682FFF6675966F959677285a0C45Efa", router: "0x820F5FfC5b525cD4d88Cd91aCf2c28F16530Cc68",
    orderVault: "0xD3D60D22d415aD43b7e64b510D86A30f19B1B12C", depositVault: "0x90c670825d0C62ede1c5ee9571d6d9a17A722DFF", withdrawalVault: "0xf5F30B10141E1F63FC11eD772931A8294a591996",
    reader: "0xa34320a507493C71Fe35E982e496F7C5d1a7fa02", glvRouter: "0x603B3D3aB077CA433b888c05fa59c777d5b6dCAD", glvVault: "0x527FB0bCfF63C47761039bB386cFE181A92a4701",
    wnt: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
  }),
});
const freeze = (value) => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
export const T_ORDER_PARAMS = freeze({ tuple: [{ tuple: ["address", "address", "address", "address", "address", "address", { array: "address" }] }, { tuple: ["uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256"] }, "uint8", "uint8", "bool", "bool", "bool", "bytes32", { array: "bytes32" }] });
export const T_DEPOSIT_PARAMS = freeze({ tuple: [{ tuple: ["address", "address", "address", "address", "address", "address", { array: "address" }, { array: "address" }] }, "uint256", "bool", "uint256", "uint256", { array: "bytes32" }] });
export const T_GLV_DEPOSIT_PARAMS = freeze({ tuple: [{ tuple: ["address", "address", "address", "address", "address", "address", "address", { array: "address" }, { array: "address" }] }, "uint256", "uint256", "uint256", "bool", "bool", { array: "bytes32" }] });
export const T_GLV_WITHDRAWAL_PARAMS = freeze({ tuple: [{ tuple: ["address", "address", "address", "address", "address", { array: "address" }, { array: "address" }] }, "uint256", "uint256", "bool", "uint256", "uint256", { array: "bytes32" }] });
export const GMX_SIGNATURES = Object.freeze({
  multicall: "multicall(bytes[])", sendWnt: "sendWnt(address,uint256)", sendTokens: "sendTokens(address,address,uint256)",
  createOrder: "createOrder(((address,address,address,address,address,address,address[]),(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256),uint8,uint8,bool,bool,bool,bytes32,bytes32[]))",
  createDeposit: "createDeposit(((address,address,address,address,address,address,address[],address[]),uint256,bool,uint256,uint256,bytes32[]))",
  createGlvDeposit: "createGlvDeposit(((address,address,address,address,address,address,address,address[],address[]),uint256,uint256,uint256,bool,bool,bytes32[]))",
  createGlvWithdrawal: "createGlvWithdrawal(((address,address,address,address,address,address[],address[]),uint256,uint256,bool,uint256,uint256,bytes32[]))",
  getAccountPositions: "getAccountPositions(address,address,uint256,uint256)", getAccountOrders: "getAccountOrders(address,address,uint256,uint256)",
  balanceOf: "balanceOf(address)", allowance: "allowance(address,address)", approve: "approve(address,uint256)", gasPrice: "eth_gasPrice",
});
export const ORDER_TYPE = Object.freeze({ MarketSwap: 0, LimitSwap: 1, MarketIncrease: 2, LimitIncrease: 3, MarketDecrease: 4, LimitDecrease: 5, StopLossDecrease: 6 });
export const POSITION_TYPE = freeze({ tuple: [{ tuple: ["address", "address", "address"] }, { tuple: ["uint256", "uint256", "uint256", "int256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256"] }, { tuple: ["bool"] }] });
export const ORDER_PROPS_TYPE = freeze({ tuple: ["bytes32", { tuple: [{ tuple: ["address", "address", "address", "address", "address", "address", "address", { array: "address" }] }, { tuple: ["uint8", "uint8", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256"] }, { tuple: ["bool", "bool", "bool", "bool"] }, { array: "bytes32" }] }] });

