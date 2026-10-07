// GET /api/demo/account?address=0x…
//
// Read-only Base Sepolia view of a SODA-derived address: ETH balance and the
// Aave V3 position, read straight from the Pool (ported from frontier's page,
// which did these reads in the browser).

import { connection as requestTime } from "next/server";
import { baseRpc } from "@/lib/intents";
import {
  addressToBytes,
  decodeReserveRates,
  decodeUserAccountData,
  erc20BalanceOfCalldata,
  getReserveDataCalldata,
  getUserAccountDataCalldata,
  rayRateToApr,
  rayRateToApy,
} from "@/lib/soda/aave";
import { AAVE, type DemoAccount } from "@/app/lib/demo/config";
import { isAddress, jsonError } from "@/app/lib/server/demo";
import { publicError } from "@/app/lib/server/solana";

export async function GET(req: Request) {
  await requestTime();
  const address = new URL(req.url).searchParams.get("address");
  if (!isAddress(address)) return jsonError("address must be 0x + 40 hex", 400);
  const rpc = baseRpc();
  try {
    const balance = await rpc.getBalance(address);
    const out: DemoAccount = { address, balanceWei: balance.toString(), aave: null };
    try {
      const who = addressToBytes(address);
      const [aWeth, usdc, debt, acct, wethRes, usdcRes] = await Promise.all([
        rpc.ethCall(AAVE.A_WETH, erc20BalanceOfCalldata(who)),
        rpc.ethCall(AAVE.USDC_UNDERLYING, erc20BalanceOfCalldata(who)),
        rpc.ethCall(AAVE.V_USDC, erc20BalanceOfCalldata(who)),
        rpc.ethCall(AAVE.POOL, getUserAccountDataCalldata(who)),
        rpc.ethCall(AAVE.POOL, getReserveDataCalldata(AAVE.WETH_UNDERLYING)),
        rpc.ethCall(AAVE.POOL, getReserveDataCalldata(AAVE.USDC_UNDERLYING)),
      ]);
      const account = decodeUserAccountData(acct);
      out.aave = {
        aWethWei: BigInt(aWeth).toString(),
        usdcUnits: BigInt(usdc).toString(),
        debtUsdcUnits: BigInt(debt).toString(),
        totalCollateralBase: account.totalCollateralBase.toString(),
        availableBorrowsBase: account.availableBorrowsBase.toString(),
        healthFactor: account.healthFactor.toString(),
        supplyApy: rayRateToApy(decodeReserveRates(wethRes).currentLiquidityRate),
        borrowApr: rayRateToApr(decodeReserveRates(usdcRes).currentVariableBorrowRate),
      };
    } catch (e) {
      out.aaveError = publicError(e);
    }
    return Response.json(out);
  } catch (e) {
    return jsonError(`Base Sepolia: ${publicError(e)}`, 502);
  }
}
